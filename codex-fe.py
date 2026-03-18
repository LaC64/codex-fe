#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import ctypes
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ORANGE = "\x1b[38;2;242;140;40m"  # #F28C28
GRAY = "\x1b[38;2;153;153;153m"   # medium gray
DIM = "\x1b[2m"
RESET = "\x1b[0m"
RESUME_EXTRA_ARGS = [
	"--dangerously-bypass-approvals-and-sandbox",
]


@dataclass
class SessionEntry:
	session_id: str
	thread_name: str
	updated_at: str
	created_at: str
	cwd: str
	model: str


def load_index(index_file: Path) -> list[SessionEntry]:
	latest_by_id: dict[str, dict[str, str]] = {}
	with index_file.open("r", encoding="utf-8", errors="replace") as handle:
		for line in handle:
			line = line.strip()
			if not line:
				continue
			try:
				obj = json.loads(line)
			except json.JSONDecodeError:
				continue
			session_id = str(obj.get("id", "")).strip()
			thread_name = str(obj.get("thread_name", "")).strip()
			updated_at = str(obj.get("updated_at", "")).strip()
			if not session_id or not thread_name:
				continue
			current = latest_by_id.get(session_id)
			if current is None or updated_at >= current["updated_at"]:
				latest_by_id[session_id] = {
					"thread_name": thread_name,
					"updated_at": updated_at,
				}

	entries: list[SessionEntry] = []
	for session_id, payload in latest_by_id.items():
		entries.append(
			SessionEntry(
				session_id=session_id,
				thread_name=payload["thread_name"],
				updated_at=payload["updated_at"],
				created_at="",
				cwd="",
				model="",
			)
		)
	return sorted(entries, key=lambda e: (e.updated_at, e.thread_name), reverse=True)


def load_session_details_by_id(sessions_root: Path) -> dict[str, tuple[str, str, str, str]]:
	# session_id -> (cwd, latest model seen in turn_context, latest timestamp in file, created timestamp)
	details: dict[str, tuple[str, str, str, str]] = {}
	for file in sessions_root.rglob("*.jsonl"):
		session_id = ""
		cwd = ""
		model = ""
		last_ts = ""
		created_ts = ""
		try:
			with file.open("r", encoding="utf-8", errors="replace") as handle:
				for line in handle:
					line = line.strip()
					if not line:
						continue
					try:
						obj: dict[str, Any] = json.loads(line)
					except json.JSONDecodeError:
						continue
					obj_type = obj.get("type")
					ts = str(obj.get("timestamp", "")).strip()
					if ts and ts > last_ts:
						last_ts = ts
					payload = obj.get("payload", {})
					if obj_type == "session_meta" and isinstance(payload, dict):
						session_id = str(payload.get("id", "")).strip() or session_id
						cwd = str(payload.get("cwd", "")).strip() or cwd
						created_ts = str(payload.get("timestamp", "")).strip() or created_ts
					elif obj_type == "turn_context" and isinstance(payload, dict):
						model = str(payload.get("model", "")).strip() or model
		except OSError:
			continue
		if session_id:
			details[session_id] = (cwd, model, last_ts, created_ts)
	return details


def truncate_text(value: str, width: int) -> str:
	if width <= 1:
		return value[:width]
	if len(value) <= width:
		return value
	if width <= 3:
		return value[:width]
	return value[: width - 3] + "..."


def parse_iso_utc(value: str) -> dt.datetime | None:
	if not value:
		return None
	text = value.strip()
	if text.endswith("Z"):
		text = text[:-1] + "+00:00"
	try:
		return dt.datetime.fromisoformat(text)
	except ValueError:
		return None


def relative_age(value: str) -> str:
	when = parse_iso_utc(value)
	if when is None:
		return "(unknown)"
	now = dt.datetime.now(dt.timezone.utc)
	delta = now - when
	seconds = int(delta.total_seconds())
	if seconds < 0:
		seconds = 0
	if seconds < 3600:
		minutes = max(1, seconds // 60)
		return f"{minutes}m ago"
	if seconds < 86400:
		hours = seconds // 3600
		return f"{hours}h ago"
	days = seconds // 86400
	return f"{days}d ago"


def get_key() -> str:
	if os.name == "nt":
		import msvcrt

		ch = msvcrt.getwch()
		if ch == "\x06":  # Ctrl+F
			return "favorite"
		if ch in ("\r", "\n"):
			try:
				if ctypes.windll.user32.GetAsyncKeyState(0x10) & 0x8000:
					return "shift_enter"
			except Exception:
				pass
			return "enter"
		if ch == "\x1b":
			return "esc"
		if ch in ("\x00", "\xe0"):
			ch2 = msvcrt.getwch()
			return {
				"H": "up",
				"P": "down",
				"I": "pageup",
				"Q": "pagedown",
				"G": "home",
				"O": "end",
			}.get(ch2, "")
		if ch == "\x08":
			return "backspace"
		if ch.lower() == "q":
			return "quit"
		if ch == "*":
			return "favorite"
		if ch.isprintable() and ch not in ("\t",):
			return f"char:{ch}"
		return ""

	import tty
	import termios

	fd = sys.stdin.fileno()
	old_settings = termios.tcgetattr(fd)
	try:
		tty.setraw(fd)
		ch = sys.stdin.read(1)
		if ch == "\x06":  # Ctrl+F
			return "favorite"
		if ch in ("\r", "\n"):
			return "enter"
		if ch == "\x1b":
			seq = sys.stdin.read(2)
			if seq == "[A":
				return "up"
			if seq == "[B":
				return "down"
			if seq == "[H":
				return "home"
			if seq == "[F":
				return "end"
			return "esc"
		if ch in ("\x08", "\x7f"):
			return "backspace"
		if ch.lower() == "q":
			return "quit"
		if ch == "*":
			return "favorite"
		if ch.isprintable() and ch not in ("\t",):
			return f"char:{ch}"
		return ""
	finally:
		termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def load_favorites(path: Path) -> set[str]:
	if not path.exists():
		return set()
	try:
		obj = json.loads(path.read_text(encoding="utf-8"))
	except Exception:
		return set()
	values = obj.get("favorites", []) if isinstance(obj, dict) else []
	return {str(v).strip() for v in values if str(v).strip()}


def save_favorites(path: Path, favorites: set[str]) -> None:
	path.write_text(
		json.dumps({"favorites": sorted(favorites)}, indent=2),
		encoding="utf-8",
	)


def apply_filter_and_sort(
	entries: list[SessionEntry], query: str, favorites: set[str]
) -> list[SessionEntry]:
	q = query.strip().lower()
	filtered = entries
	if q:
		filtered = [
			e
			for e in entries
			if q in e.thread_name.lower()
			or q in e.model.lower()
			or q in e.updated_at.lower()
			or q in e.cwd.lower()
		]
	# Preserve updated-time order from source list, but move favorites to top.
	return sorted(filtered, key=lambda e: 0 if e.session_id in favorites else 1)


def render_menu(
	entries: list[SessionEntry],
	selected: int,
	top: int,
	query: str,
	favorites: set[str],
) -> tuple[int, int]:
	term_width = os.get_terminal_size().columns
	term_height = os.get_terminal_size().lines
	max_rows = max(5, term_height - 8)

	pin_w = 3
	name_w = min(30, max(16, term_width // 5))
	model_w = min(18, max(10, term_width // 8))
	updated_w = 9
	created_w = 9
	cwd_w = max(20, term_width - (pin_w + name_w + model_w + updated_w + created_w + 14))

	print("\x1b[2J\x1b[H", end="")
	print(
		f"{ORANGE}Codex Resume Picker{RESET}  "
		f"{GRAY}(Up/Down Enter select, Shift+Enter open tab, type filter, Backspace, Ctrl+F or * favorite, q quit){RESET}"
	)
	print(f"{ORANGE}Filter:{RESET} {GRAY}{query if query else '(none)'}{RESET}")
	print(
		f"{GRAY}{'Pin'.ljust(pin_w)} {'Name'.ljust(name_w)}  "
		f"{'Model'.ljust(model_w)}  {'Updated'.ljust(updated_w)}  "
		f"{'Created'.ljust(created_w)}  "
		f"{'Folder'.ljust(cwd_w)}{RESET}"
	)
	print(
		f"{DIM}{'-' * min(term_width, pin_w + name_w + model_w + updated_w + created_w + cwd_w + 10)}{RESET}"
	)

	if not entries:
		print(f"{GRAY}(No sessions match current filter){RESET}")
		print(f"\n{ORANGE}0{RESET}{GRAY}/0{RESET}")
		return max_rows, term_height

	visible = entries[top : top + max_rows]
	for idx, entry in enumerate(visible):
		real_idx = top + idx
		pin = "*" if entry.session_id in favorites else " "
		name = truncate_text(entry.thread_name, name_w)
		model = truncate_text(entry.model or "(unknown)", model_w)
		updated = truncate_text(relative_age(entry.updated_at), updated_w)
		created = truncate_text(relative_age(entry.created_at), created_w)
		cwd = truncate_text(entry.cwd or "(cwd unknown)", cwd_w)
		line = (
			f"{pin.ljust(pin_w)} {name.ljust(name_w)}  "
			f"{model.ljust(model_w)}  {updated.ljust(updated_w)}  "
			f"{created.ljust(created_w)}  {cwd.ljust(cwd_w)}"
		)
		if real_idx == selected:
			print(f"{ORANGE}> {line}{RESET}")
		else:
			print(f"{GRAY}  {line}{RESET}")

	print(f"\n{ORANGE}{selected + 1}{RESET}{GRAY}/{len(entries)}{RESET}")
	return max_rows, term_height


def interactive_pick(
	entries: list[SessionEntry],
	favorites_file: Path,
	open_in_tab_cb,
) -> SessionEntry | None:
	if not entries:
		return None

	favorites = load_favorites(favorites_file)
	query = ""
	view = apply_filter_and_sort(entries, query, favorites)
	selected = 0
	top = 0

	while True:
		max_rows, _ = render_menu(view, selected, top, query, favorites)
		key = get_key()
		if key in ("quit", "esc"):
			return None
		if key == "enter":
			if not view:
				continue
			print("\x1b[2J\x1b[H", end="")
			return view[selected]
		if key == "shift_enter":
			if not view:
				continue
			open_in_tab_cb(view[selected])
			continue
		if key == "favorite":
			if not view:
				continue
			target = view[selected].session_id
			if target in favorites:
				favorites.remove(target)
			else:
				favorites.add(target)
			save_favorites(favorites_file, favorites)
			current_id = target
			view = apply_filter_and_sort(entries, query, favorites)
			selected = next((i for i, e in enumerate(view) if e.session_id == current_id), 0)
			top = 0
		elif key == "backspace":
			if query:
				query = query[:-1]
				view = apply_filter_and_sort(entries, query, favorites)
				selected = 0
				top = 0
		elif key.startswith("char:"):
			query += key[5:]
			view = apply_filter_and_sort(entries, query, favorites)
			selected = 0
			top = 0

		if not view:
			continue

		if key == "up":
			selected = max(0, selected - 1)
		elif key == "down":
			selected = min(len(view) - 1, selected + 1)
		elif key == "home":
			selected = 0
		elif key == "end":
			selected = len(view) - 1
		elif key == "pageup":
			selected = max(0, selected - max_rows)
		elif key == "pagedown":
			selected = min(len(view) - 1, selected + max_rows)

		if selected < top:
			top = selected
		elif selected >= top + max_rows:
			top = selected - max_rows + 1


def set_terminal_title(title: str) -> None:
	if not title:
		return
	if os.name == "nt":
		try:
			ctypes.windll.kernel32.SetConsoleTitleW(title)
		except Exception:
			pass
	# OSC title sequence helps on terminals that support it.
	print(f"\x1b]0;{title}\x07", end="", flush=True)


def resolve_codex_executable() -> str | None:
	candidates = ["codex.cmd", "codex.CMD", "codex.bat", "codex.exe", "codex"]
	for candidate in candidates:
		resolved = shutil.which(candidate)
		if resolved:
			return resolved
	local_shell = Path(__file__).resolve().parent / "codex_shell.cmd"
	if local_shell.exists():
		return str(local_shell)
	return None


def make_resume_ps_command(entry: SessionEntry, codex_exe: str, run_cwd: str) -> str:
	ps_title = entry.thread_name.replace("'", "''")
	ps_exe = codex_exe.replace("'", "''")
	ps_cwd = str(run_cwd).replace("'", "''")
	ps_extra = ", ".join(f"'{arg}'" for arg in RESUME_EXTRA_ARGS)
	return (
		"$ErrorActionPreference = 'SilentlyContinue'; "
		f"$title = '{ps_title}'; "
		f"$exe = '{ps_exe}'; "
		f"$cwd = '{ps_cwd}'; "
		"$Host.UI.RawUI.WindowTitle = $title; "
		"Set-Location -LiteralPath $cwd; "
		"$p = Start-Process -FilePath $exe -ArgumentList @('resume', "
		f"'{entry.session_id}', {ps_extra}) -NoNewWindow -PassThru; "
		"while (-not $p.HasExited) { "
		"$Host.UI.RawUI.WindowTitle = $title; "
		"Start-Sleep -Milliseconds 250; "
		"$p.Refresh() "
		"}; "
		"exit $p.ExitCode"
	)


def open_session_in_tab(entry: SessionEntry) -> bool:
	if os.name != "nt":
		print("Opening tabs is only supported on Windows Terminal.")
		return False
	wt_exe = shutil.which("wt.exe") or shutil.which("wt")
	if not wt_exe:
		print("Windows Terminal (`wt`) not found; cannot open a new tab.")
		return False
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return False
	run_cwd = entry.cwd if entry.cwd and Path(entry.cwd).exists() else os.getcwd()
	ps_cmd = make_resume_ps_command(entry, codex_exe, run_cwd)
	encoded_cmd = base64.b64encode(ps_cmd.encode("utf-16le")).decode("ascii")
	title = entry.thread_name
	try:
		subprocess.Popen(
			[
				wt_exe,
				"-w",
				"0",
				"new-tab",
				"--title",
				title,
				"--tabColor",
				"#F28C28",
				"-d",
				run_cwd,
				"powershell",
				"-NoExit",
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				encoded_cmd,
			]
		)
		return True
	except Exception as exc:
		print(f"Failed to open tab: {exc}")
		return False


def launch_resume(entry: SessionEntry) -> int:
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return 1

	run_cwd = entry.cwd if entry.cwd and Path(entry.cwd).exists() else None
	if run_cwd is None:
		print("Selected session has no usable cwd; running from current folder.")
		run_cwd = os.getcwd()

	set_terminal_title(entry.thread_name)
	print(
		f"Launching: {codex_exe} resume {entry.session_id} "
		f"{' '.join(RESUME_EXTRA_ARGS)}"
	)
	print(f"Folder: {run_cwd}")

	if os.name == "nt":
		script_body = make_resume_ps_command(entry, codex_exe, run_cwd).replace("; ", ";\n")
		temp_path = None
		try:
			with tempfile.NamedTemporaryFile(
				mode="w",
				suffix=".ps1",
				prefix="codex_resume_",
				delete=False,
				encoding="utf-8",
			) as tmp:
				tmp.write(script_body)
				temp_path = tmp.name
			return subprocess.call(
				[
					"powershell",
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					temp_path,
				],
				cwd=run_cwd,
			)
		finally:
			if temp_path:
				try:
					os.remove(temp_path)
				except OSError:
					pass

	return subprocess.call(
		[codex_exe, "resume", entry.session_id, *RESUME_EXTRA_ARGS], cwd=run_cwd
	)


def print_list(
	entries: list[SessionEntry],
	show_id: bool,
	show_cwd: bool,
	favorites: set[str],
) -> None:
	ordered = apply_filter_and_sort(entries, "", favorites)
	for entry in ordered:
		prefix = "* " if entry.session_id in favorites else "  "
		parts = [
			f"{prefix}{entry.thread_name}",
			entry.model or "(unknown)",
			relative_age(entry.updated_at),
			relative_age(entry.created_at),
		]
		if show_id:
			parts.append(entry.session_id)
		if show_cwd:
			parts.append(entry.cwd or "(cwd unknown)")
		print("\t".join(parts))
	print(f"\nTotal sessions: {len(ordered)}")


def main() -> int:
	parser = argparse.ArgumentParser(
		description=(
			"Interactive Codex session picker: choose a thread and launch `codex resume`."
		)
	)
	parser.add_argument(
		"--codex-home",
		type=Path,
		default=Path.home() / ".codex",
		help="Codex home directory (default: ~/.codex)",
	)
	parser.add_argument(
		"--name",
		type=str,
		default="",
		help="Initial filter (interactive) or list filter substring.",
	)
	parser.add_argument(
		"--list",
		action="store_true",
		help="List sessions instead of opening interactive picker.",
	)
	parser.add_argument(
		"--show-id",
		action="store_true",
		help="When using --list, include session UUID.",
	)
	parser.add_argument(
		"--show-cwd",
		action="store_true",
		help="When using --list, include original session folder.",
	)
	parser.add_argument(
		"--open-favorites",
		action="store_true",
		help="Open all favorited sessions as new Windows Terminal tabs in the current window.",
	)
	args = parser.parse_args()

	codex_home = args.codex_home.expanduser()
	index_file = codex_home / "session_index.jsonl"
	sessions_root = codex_home / "sessions"
	favorites_file = codex_home / "session_favorites.json"

	if not index_file.exists():
		print(f"Session index not found: {index_file}")
		return 1

	entries = load_index(index_file)
	details_by_id = load_session_details_by_id(sessions_root)
	for entry in entries:
		cwd, model, last_ts, created_ts = details_by_id.get(entry.session_id, ("", "", "", ""))
		entry.cwd = cwd
		entry.model = model
		if last_ts:
			entry.updated_at = last_ts
		if created_ts:
			entry.created_at = created_ts

	initial_filter = args.name.lower().strip()
	if initial_filter:
		entries = [e for e in entries if initial_filter in e.thread_name.lower()]

	if not entries:
		print("No sessions matched.")
		return 1

	favorites = load_favorites(favorites_file)

	if args.open_favorites:
		fav_entries = [e for e in entries if e.session_id in favorites]
		if not fav_entries:
			print("No favorites to open.")
			return 0
		opened = 0
		for entry in fav_entries:
			if open_session_in_tab(entry):
				opened += 1
		print(f"Opened {opened}/{len(fav_entries)} favorite sessions in new tab(s).")
		return 0

	if args.list or not sys.stdout.isatty() or not sys.stdin.isatty():
		print_list(entries, args.show_id, args.show_cwd, favorites)
		return 0

	selection = interactive_pick(entries, favorites_file, open_session_in_tab)
	if selection is None:
		print("Cancelled.")
		return 0
	return launch_resume(selection)


if __name__ == "__main__":
	raise SystemExit(main())
