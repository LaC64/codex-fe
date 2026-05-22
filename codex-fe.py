#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import ctypes
import datetime as dt
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ORANGE = "\x1b[38;2;242;140;40m"  # #F28C28
GRAY = "\x1b[38;2;153;153;153m"   # medium gray
DIM = "\x1b[2m"
RESET = "\x1b[0m"
FULL_CLEAR = "\x1b[3J\x1b[2J\x1b[H"
RESUME_EXTRA_ARGS = [
	"--dangerously-bypass-approvals-and-sandbox",
]
SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]
UNNAMED_PREVIEW_CHARS = 360
SESSION_DETAILS_CACHE_VERSION = 1
SESSION_DETAILS_HEAD_BYTES = 1024 * 1024
SESSION_DETAILS_TAIL_BYTES = 8 * 1024 * 1024
ASCII_ART_LINES = [
	"  .____________________________________________________________________________.",
	" /                                                                            /|",
	"+----------------------------------------------------------------------------+ |",
	"|                                                                            | |",
	"|        CCC    OOO    DDDD   EEEEE  X   X       FFFFF  EEEEE                | |",
	"|       C   C  O   O   D   D  E       X X        F      E                    | |",
	"|       C      O   O   D   D  EEEE     X         FFF    EEEE                 | |",
	"|       C   C  O   O   D   D  E       X X        F      E                    | |",
	"|        CCC    OOO    DDDD   EEEEE  X   X       F      EEEEE                | |",
	"|                                                                            | |",
	"|                                                                            | |",
	"|                        session picker / resume front end                   | |",
	"|                                                                            | |",
	"|                    favorites  filter  unnamed  new chat  tabs              | |",
	"|                                                                            | |",
	"|          ________________________________________________________          | |",
	"+---------/________________________________________________________/---------+/",
	" '----------------------------------------------------------------------------' ",
]


@dataclass
class SessionEntry:
	session_id: str
	thread_name: str
	updated_at: str
	created_at: str
	cwd: str
	model: str
	is_named: bool
	session_file: str


@dataclass
class PickerResult:
	action: str
	entry: SessionEntry | None


@dataclass
class SessionDetailsState:
	session_id: str
	meta_cwd: str = ""
	last_used_cwd: str = ""
	model: str = ""
	last_ts: str = ""
	created_ts: str = ""
	first_user_preview: str = ""


def clean_text(value: str) -> str:
	return " ".join(value.split())


def normalize_title(value: str) -> str:
	return clean_text(value).strip().lower()


def fit_banner_line(value: str, width: int) -> str:
	if width <= 0:
		return ""
	if len(value) >= width:
		return value[:width]
	return value.center(width)


def extract_line_timestamp(line: str) -> str:
	prefix = '{"timestamp":"'
	if not line.startswith(prefix):
		return ""
	end = line.find('"', len(prefix))
	if end == -1:
		return ""
	return line[len(prefix) : end]


def extract_session_id_from_filename(path: Path) -> str:
	stem = path.stem
	if len(stem) < 36:
		return ""
	candidate = stem[-36:]
	if (
		len(candidate) == 36
		and candidate[8] == "-"
		and candidate[13] == "-"
		and candidate[18] == "-"
		and candidate[23] == "-"
	):
		return candidate
	return ""


def extract_json_string_field(line: str, field_name: str, start: int = 0) -> str:
	token = f'"{field_name}":"'
	pos = line.find(token, start)
	if pos == -1:
		return ""
	value_start = pos + len(token)
	i = value_start
	escaped = False
	while i < len(line):
		ch = line[i]
		if escaped:
			escaped = False
		elif ch == "\\":
			escaped = True
		elif ch == '"':
			raw = line[value_start:i]
			try:
				return json.loads(f'"{raw}"')
			except json.JSONDecodeError:
				return raw
		i += 1
	return ""


def extract_message_text(payload: dict[str, Any]) -> str:
	if payload.get("type") != "message":
		return ""
	role = str(payload.get("role", "")).strip().lower()
	if role not in ("user", "assistant"):
		return ""
	content = payload.get("content", [])
	if not isinstance(content, list):
		return ""
	parts: list[str] = []
	for item in content:
		if not isinstance(item, dict):
			continue
		text = item.get("input_text") or item.get("text")
		if not isinstance(text, str):
			continue
		candidate = clean_text(text)
		if candidate:
			parts.append(candidate)
	return " ".join(parts)


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
				is_named=True,
				session_file="",
			)
		)
	return sorted(entries, key=lambda e: (e.updated_at, e.thread_name), reverse=True)


def decode_jsonl_line(raw_line: bytes) -> str:
	return raw_line.decode("utf-8", errors="replace").rstrip("\r\n")


def read_head_lines(file: Path, max_bytes: int, file_size: int) -> list[str]:
	with file.open("rb") as handle:
		data = handle.read(min(max_bytes, file_size))
	if not data:
		return []
	lines = data.splitlines()
	if file_size > max_bytes and data[-1:] not in (b"\n", b"\r"):
		lines = lines[:-1]
	return [decode_jsonl_line(line) for line in lines if line]


def read_tail_lines(file: Path, max_bytes: int, file_size: int) -> list[str]:
	if file_size <= 0:
		return []
	start = max(0, file_size - max_bytes)
	with file.open("rb") as handle:
		handle.seek(start)
		data = handle.read()
	if not data:
		return []
	lines = data.splitlines()
	if start > 0 and data[:1] not in (b"\n", b"\r"):
		lines = lines[1:]
	return [decode_jsonl_line(line) for line in lines if line]


def normalize_details_tuple(value: Any) -> tuple[str, str, str, str, str, str] | None:
	if not isinstance(value, (list, tuple)) or len(value) != 6:
		return None
	return (
		str(value[0]),
		str(value[1]),
		str(value[2]),
		str(value[3]),
		str(value[4]),
		str(value[5]),
	)


def apply_head_session_detail_line(
	line: str, filename_session_id: str, state: SessionDetailsState
) -> None:
	ts = extract_line_timestamp(line)
	if ts and ts > state.last_ts:
		state.last_ts = ts
	head = line[:500]
	is_session_meta = '"type":"session_meta"' in head
	is_turn_context = '"type":"turn_context"' in head
	is_first_user_message = (
		not state.first_user_preview
		and '"type":"response_item"' in head
		and '"type":"message"' in head
		and '"role":"user"' in head
	)
	if not (is_session_meta or is_turn_context or is_first_user_message):
		return
	try:
		obj: dict[str, Any] = json.loads(line)
	except json.JSONDecodeError:
		if is_session_meta:
			if not state.session_id:
				state.session_id = extract_json_string_field(line, "id")
			state.meta_cwd = extract_json_string_field(line, "cwd") or state.meta_cwd
		return
	obj_type = obj.get("type")
	payload = obj.get("payload", {})
	if obj_type == "session_meta" and isinstance(payload, dict):
		payload_session_id = str(payload.get("id", "")).strip()
		if not state.session_id:
			state.session_id = payload_session_id
		elif filename_session_id and payload_session_id != filename_session_id:
			return
		state.meta_cwd = str(payload.get("cwd", "")).strip() or state.meta_cwd
		state.created_ts = str(payload.get("timestamp", "")).strip() or state.created_ts
	elif obj_type == "turn_context" and isinstance(payload, dict):
		state.model = str(payload.get("model", "")).strip() or state.model
		state.last_used_cwd = str(payload.get("cwd", "")).strip() or state.last_used_cwd
	elif obj_type == "response_item" and isinstance(payload, dict):
		if (
			not state.first_user_preview
			and payload.get("type") == "message"
			and payload.get("role") == "user"
		):
			content = payload.get("content", [])
			if isinstance(content, list):
				for item in content:
					if not isinstance(item, dict):
						continue
					text = item.get("input_text") or item.get("text")
					if not isinstance(text, str):
						continue
					candidate = clean_text(text)
					if not candidate:
						continue
					if candidate.startswith("# AGENTS.md instructions"):
						continue
					if candidate.startswith("<environment_context>"):
						continue
					state.first_user_preview = candidate[:UNNAMED_PREVIEW_CHARS]
					break


def apply_tail_session_detail_line(line: str, state: SessionDetailsState) -> bool:
	head = line[:500]
	if '"type":"turn_context"' not in head:
		return False
	try:
		obj: dict[str, Any] = json.loads(line)
	except json.JSONDecodeError:
		return False
	payload = obj.get("payload", {})
	if obj.get("type") != "turn_context" or not isinstance(payload, dict):
		return False
	state.model = str(payload.get("model", "")).strip() or state.model
	state.last_used_cwd = str(payload.get("cwd", "")).strip() or state.last_used_cwd
	return True


def parse_session_details_file(
	file: Path,
	previous_details: tuple[str, str, str, str, str, str] | None = None,
	file_size: int | None = None,
) -> tuple[str, tuple[str, str, str, str, str, str]] | None:
	filename_session_id = extract_session_id_from_filename(file)
	state = SessionDetailsState(session_id=filename_session_id)
	if previous_details is not None:
		state.last_used_cwd = previous_details[0]
		state.model = previous_details[1]
		state.last_ts = previous_details[2]
		state.created_ts = previous_details[3]
		state.first_user_preview = previous_details[4]
	try:
		size = file_size if file_size is not None else file.stat().st_size
		for line in read_head_lines(file, SESSION_DETAILS_HEAD_BYTES, size):
			apply_head_session_detail_line(line, filename_session_id, state)

		found_last_ts = False
		found_turn_context = False
		for line in reversed(read_tail_lines(file, SESSION_DETAILS_TAIL_BYTES, size)):
			if not found_last_ts:
				ts = extract_line_timestamp(line)
				if ts:
					if ts > state.last_ts:
						state.last_ts = ts
					found_last_ts = True
			if not found_turn_context:
				found_turn_context = apply_tail_session_detail_line(line, state)
			if found_last_ts and found_turn_context:
				break
	except OSError:
		return None
	if not state.session_id:
		return None
	effective_cwd = state.last_used_cwd or state.meta_cwd
	return (
		state.session_id,
		(
			effective_cwd,
			state.model,
			state.last_ts,
			state.created_ts,
			state.first_user_preview,
			str(file),
		),
	)


def load_session_details_cache(cache_file: Path) -> dict[str, dict[str, Any]]:
	if not cache_file.exists():
		return {}
	try:
		obj = json.loads(cache_file.read_text(encoding="utf-8"))
	except Exception:
		return {}
	if not isinstance(obj, dict):
		return {}
	if obj.get("version") != SESSION_DETAILS_CACHE_VERSION:
		return {}
	files = obj.get("files", {})
	return files if isinstance(files, dict) else {}


def save_session_details_cache(cache_file: Path, files: dict[str, dict[str, Any]]) -> None:
	payload = {
		"version": SESSION_DETAILS_CACHE_VERSION,
		"files": files,
	}
	try:
		cache_file.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
	except OSError:
		pass


def load_session_details_by_id(
	sessions_root: Path, cache_file: Path | None = None
) -> dict[str, tuple[str, str, str, str, str, str]]:
	# session_id -> (cwd, latest model, last timestamp, created timestamp, first user preview, file path)
	details: dict[str, tuple[str, str, str, str, str, str]] = {}
	cache = load_session_details_cache(cache_file) if cache_file is not None else {}
	next_cache: dict[str, dict[str, Any]] = {}

	for file in sessions_root.rglob("*.jsonl"):
		try:
			stat = file.stat()
		except OSError:
			continue
		file_key = str(file)
		cached = cache.get(file_key)
		if (
			isinstance(cached, dict)
			and cached.get("size") == stat.st_size
			and cached.get("mtime_ns") == stat.st_mtime_ns
		):
			session_id = str(cached.get("session_id", "")).strip()
			cached_details = normalize_details_tuple(cached.get("details", []))
			if session_id and cached_details is not None:
				details[session_id] = cached_details
				next_cache[file_key] = cached
				continue

		previous_details = None
		if isinstance(cached, dict):
			cached_size = cached.get("size", -1)
			if isinstance(cached_size, int) and 0 <= cached_size <= stat.st_size:
				previous_details = normalize_details_tuple(cached.get("details", []))

		parsed = parse_session_details_file(file, previous_details, stat.st_size)
		if parsed is None:
			continue
		session_id, parsed_details = parsed
		details[session_id] = parsed_details
		next_cache[file_key] = {
			"size": stat.st_size,
			"mtime_ns": stat.st_mtime_ns,
			"session_id": session_id,
			"details": list(parsed_details),
		}

	if cache_file is not None and next_cache != cache:
		save_session_details_cache(cache_file, next_cache)
	return details


def search_sessions_by_content(sessions_root: Path, query: str) -> set[str]:
	q = query.strip().lower()
	if not q:
		return set()

	matches: set[str] = set()
	for file in sessions_root.rglob("*.jsonl"):
		session_id = extract_session_id_from_filename(file)
		try:
			with file.open("r", encoding="utf-8", errors="replace") as handle:
				for line in handle:
					line = line.rstrip("\r\n")
					if not line:
						continue
					head = line[:500]
					if '"type":"session_meta"' in head:
						try:
							obj: dict[str, Any] = json.loads(line)
						except json.JSONDecodeError:
							continue
						payload = obj.get("payload", {})
						if isinstance(payload, dict):
							if not session_id:
								session_id = str(payload.get("id", "")).strip()
						continue
					if (
						'"type":"response_item"' not in head
						or '"type":"message"' not in head
						or ('"role":"user"' not in head and '"role":"assistant"' not in head)
					):
						continue
					if q not in line.lower():
						continue
					try:
						obj: dict[str, Any] = json.loads(line)
					except json.JSONDecodeError:
						continue
					payload = obj.get("payload", {})
					if obj.get("type") == "response_item" and isinstance(payload, dict):
						message_text = extract_message_text(payload)
						if message_text and q in message_text.lower():
							if session_id:
								matches.add(session_id)
								break
		except OSError:
			continue
	return matches


def copy_text_to_clipboard(value: str) -> bool:
	if not value:
		return False
	try:
		if os.name == "nt":
			subprocess.run(["clip"], input=value, text=True, check=True)
			return True
		for command in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]):
			if shutil.which(command[0]):
				subprocess.run(command, input=value, text=True, check=True)
				return True
	except Exception:
		return False
	return False


def copy_selected_session_file_path(entry: SessionEntry) -> None:
	if copy_text_to_clipboard(entry.session_file):
		print(f"Copied session file path:\n{entry.session_file}")
	else:
		print("Selected session does not have a session file path to copy.")
	if sys.stdin.isatty():
		input("Press Enter to return to picker...")


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

		def alt_pressed() -> bool:
			try:
				user32 = ctypes.windll.user32
				return bool(
					(user32.GetAsyncKeyState(0x12) & 0x8000)  # VK_MENU
					or (user32.GetAsyncKeyState(0xA4) & 0x8000)  # VK_LMENU
					or (user32.GetAsyncKeyState(0xA5) & 0x8000)  # VK_RMENU
				)
			except Exception:
				return False

		ch = msvcrt.getwch()
		if ch == "\x06":  # Ctrl+F
			return "favorite"
		if ch == "\x10":  # Ctrl+P
			return "copy_session_file"
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
		if alt_pressed():
			if ch.lower() == "q":
				return "quit"
			if ch.lower() == "a":
				return "toggle_unnamed"
			if ch.lower() == "s":
				return "search_conversations"
			if ch == "O":
				return "open_all_favorites"
			if ch == "N":
				return "new_chat_tab"
			if ch == "n":
				return "new_chat_current"
			if ch.lower() == "r":
				return "refresh"
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
		if ch == "\x10":  # Ctrl+P
			return "copy_session_file"
		if ch in ("\r", "\n"):
			return "enter"
		if ch == "\x1b":
			ready, _, _ = select.select([sys.stdin], [], [], 0.02)
			if not ready:
				return "esc"
			next_ch = sys.stdin.read(1)
			if next_ch == "[":
				next2 = sys.stdin.read(1)
				if next2 == "A":
					return "up"
				if next2 == "B":
					return "down"
				if next2 == "H":
					return "home"
				if next2 == "F":
					return "end"
				return ""
			# Alt+<key> arrives as ESC + key on many Unix terminals.
			if next_ch.lower() == "q":
				return "quit"
			if next_ch.lower() == "a":
				return "toggle_unnamed"
			if next_ch.lower() == "s":
				return "search_conversations"
			if next_ch == "O":
				return "open_all_favorites"
			if next_ch == "N":
				return "new_chat_tab"
			if next_ch == "n":
				return "new_chat_current"
			if next_ch.lower() == "r":
				return "refresh"
			if next_ch.isprintable() and next_ch not in ("\t",):
				return f"char:{next_ch}"
			return ""
		if ch in ("\x08", "\x7f"):
			return "backspace"
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
	entries: list[SessionEntry],
	query: str,
	favorites: set[str],
	show_unnamed: bool,
	content_matches: set[str] | None = None,
) -> list[SessionEntry]:
	q = query.strip().lower()
	include_unnamed = show_unnamed or content_matches is not None
	filtered = [e for e in entries if include_unnamed or e.is_named]
	if q:
		filtered = [
			e
			for e in entries
			if (include_unnamed or e.is_named)
			if q in e.thread_name.lower()
			or q in e.model.lower()
			or q in e.updated_at.lower()
			or q in e.cwd.lower()
		]
	if content_matches is not None:
		filtered = [e for e in filtered if e.session_id in content_matches]
	# Keep named before unnamed, favorites on top inside each section.
	return sorted(
		filtered,
		key=lambda e: (
			0 if e.is_named else 1,
			0 if e.session_id in favorites else 1,
		),
	)


def build_display_rows(
	entries: list[SessionEntry],
) -> tuple[list[tuple[str, SessionEntry | None]], list[int]]:
	rows: list[tuple[str, SessionEntry | None]] = []
	entry_to_row: list[int] = []
	first_unnamed_index = next((i for i, e in enumerate(entries) if not e.is_named), -1)
	for i, entry in enumerate(entries):
		if first_unnamed_index != -1 and i == first_unnamed_index and first_unnamed_index > 0:
			rows.append(("sep", None))
			rows.append(("label", None))
		entry_to_row.append(len(rows))
		if entry.is_named:
			rows.append(("entry", entry))
		else:
			rows.append(("unnamed_desc", entry))
			rows.append(("unnamed_meta", entry))
	return rows, entry_to_row


def render_menu(
	entries: list[SessionEntry],
	selected: int,
	top: int,
	query: str,
	conversation_query: str,
	favorites: set[str],
	show_unnamed: bool,
) -> tuple[int, int, int, int]:
	term_width = os.get_terminal_size().columns
	term_height = os.get_terminal_size().lines
	max_rows = max(1, term_height - (len(ASCII_ART_LINES) + 9))
	lines: list[str] = []

	def paint(lines_to_draw: list[str]) -> None:
		body = "\n".join(f"{line}\x1b[K" for line in lines_to_draw)
		sys.stdout.write("\x1b[H" + body + "\x1b[J")
		sys.stdout.flush()

	pin_w = 3
	name_w = min(30, max(16, term_width // 5))
	model_w = min(18, max(10, term_width // 8))
	updated_w = 9
	created_w = 9
	cwd_w = max(20, term_width - (pin_w + name_w + model_w + updated_w + created_w + 14))

	for i, art_line in enumerate(ASCII_ART_LINES):
		color = ORANGE if i < 11 or i >= 17 else GRAY
		lines.append(f"{color}{fit_banner_line(art_line, term_width)}{RESET}")

	lines.append(
		f"{ORANGE}Codex Resume Picker{RESET}  "
		f"{GRAY}(Up/Down Enter select, Shift+Enter open session tab, Alt+n new chat here, Alt+N new chat tab, Alt+s convo search, Ctrl+P copy file path, Alt+Shift+O open all favorites, Alt+r refresh, Alt+a toggle unnamed, type filter, Backspace, Ctrl+F or * favorite, Alt+q quit){RESET}"
	)
	unnamed_state = "ON" if show_unnamed else "OFF"
	lines.append(f"{ORANGE}Unnamed:{RESET} {GRAY}{unnamed_state}{RESET}")
	lines.append(f"{ORANGE}Filter:{RESET} {GRAY}{query if query else '(none)'}{RESET}")
	lines.append(
		f"{ORANGE}Search:{RESET} {GRAY}{conversation_query if conversation_query else '(none)'}{RESET}"
	)
	lines.append(
		f"{GRAY}{'Pin'.ljust(pin_w)} {'Name'.ljust(name_w)}  "
		f"{'Model'.ljust(model_w)}  {'Updated'.ljust(updated_w)}  "
		f"{'Created'.ljust(created_w)}  "
		f"{'Folder'.ljust(cwd_w)}{RESET}"
	)
	lines.append(
		f"{DIM}{'-' * min(term_width, pin_w + name_w + model_w + updated_w + created_w + cwd_w + 10)}{RESET}"
	)

	if not entries:
		lines.append(f"{GRAY}(No sessions match current filter){RESET}")
		lines.append("")
		lines.append(f"{ORANGE}0{RESET}{GRAY}/0{RESET}")
		paint(lines)
		return max_rows, term_height, top, 0

	rows, entry_to_row = build_display_rows(entries)
	if selected < 0:
		selected = 0
	elif selected >= len(entries):
		selected = len(entries) - 1
	selected_row = entry_to_row[selected]
	max_top = max(0, len(rows) - max_rows)
	effective_top = min(max(0, top), max_top)
	visible = rows[effective_top : effective_top + max_rows]

	for idx, (kind, payload) in enumerate(visible):
		real_row = effective_top + idx
		if kind == "sep":
			sep = f"{DIM}{'-' * min(term_width, pin_w + name_w + model_w + updated_w + created_w + cwd_w + 10)}{RESET}"
			lines.append(sep)
			continue
		if kind == "label":
			lines.append(f"{GRAY}  [Unnamed Sessions]{RESET}")
			continue
		entry = payload
		if entry is None:
			continue
		if kind == "unnamed_desc":
			desc_w = max(20, term_width - 6)
			desc = truncate_text(entry.thread_name, desc_w)
			if real_row == selected_row:
				lines.append(f"{ORANGE}> {desc}{RESET}")
			else:
				lines.append(f"{GRAY}  {desc}{RESET}")
			continue
		if kind == "unnamed_meta":
			model = truncate_text(entry.model or "(unknown)", model_w)
			updated = truncate_text(relative_age(entry.updated_at), updated_w)
			created = truncate_text(relative_age(entry.created_at), created_w)
			cwd = truncate_text(entry.cwd or "(cwd unknown)", term_width - 12)
			meta = (
				f"    {model.ljust(model_w)}  {updated.ljust(updated_w)}  "
				f"{created.ljust(created_w)}  {cwd}"
			)
			if real_row - 1 == selected_row:
				lines.append(f"{ORANGE}{meta}{RESET}")
			else:
				lines.append(f"{GRAY}{meta}{RESET}")
			continue
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
		if real_row == selected_row:
			lines.append(f"{ORANGE}> {line}{RESET}")
		else:
			lines.append(f"{GRAY}  {line}{RESET}")

	lines.append("")
	lines.append(f"{ORANGE}{selected + 1}{RESET}{GRAY}/{len(entries)}{RESET}")
	paint(lines)
	return max_rows, term_height, effective_top, len(rows)


def interactive_pick(
	entries: list[SessionEntry],
	favorites_file: Path,
	open_in_tab_cb,
	open_new_chat_tab_cb,
	open_all_favorites_cb,
	refresh_entries_cb,
	search_conversations_cb,
) -> PickerResult | None:
	if not entries:
		return None

	favorites = load_favorites(favorites_file)
	query = ""
	conversation_query = ""
	content_matches: set[str] | None = None
	show_unnamed = False
	all_entries = entries
	view = apply_filter_and_sort(
		all_entries, query, favorites, show_unnamed, content_matches
	)
	selected = 0
	top = 0

	def run_outside_alt_screen(cb, *args, **kwargs):
		sys.stdout.write("\x1b[?1049l")
		sys.stdout.flush()
		try:
			return cb(*args, **kwargs)
		finally:
			sys.stdout.write("\x1b[?1049h\x1b[2J\x1b[H")
			sys.stdout.flush()

	def prompt_conversation_search(current_value: str) -> str | None:
		print("")
		print(f"{ORANGE}Conversation Search{RESET}")
		print("Type text to search inside conversation history. Blank clears the search.")
		if current_value:
			print(f"Current: {current_value}")
		try:
			return input("Search text: ").strip()
		except EOFError:
			return None

	sys.stdout.write("\x1b[?1049h\x1b[2J\x1b[H")
	sys.stdout.flush()
	try:
		while True:
			max_rows, _, top, _ = render_menu(
				view,
				selected,
				top,
				query,
				conversation_query,
				favorites,
				show_unnamed,
			)
			key = get_key()
			if key in ("quit", "esc"):
				return None
			if key == "toggle_unnamed":
				show_unnamed = not show_unnamed
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
				selected = 0
				top = 0
				continue
			if key == "search_conversations":
				new_query = run_outside_alt_screen(
					prompt_conversation_search, conversation_query
				)
				if new_query is None:
					continue
				conversation_query = new_query
				if conversation_query:
					content_matches = run_outside_alt_screen(
						search_conversations_cb, conversation_query
					)
				else:
					content_matches = None
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
				selected = 0
				top = 0
				continue
			if key == "copy_session_file":
				if not view:
					continue
				run_outside_alt_screen(
					copy_selected_session_file_path, view[selected]
				)
				continue
			if key == "new_chat_tab":
				base_entry = view[selected] if view else None
				open_new_chat_tab_cb(base_entry)
				continue
			if key == "open_all_favorites":
				run_outside_alt_screen(open_all_favorites_cb, all_entries, favorites)
				continue
			if key == "new_chat_current":
				base_entry = view[selected] if view else None
				return PickerResult(action="new_chat_current", entry=base_entry)
			if key == "refresh":
				current_id = view[selected].session_id if view else ""
				all_entries = refresh_entries_cb()
				if conversation_query:
					content_matches = search_conversations_cb(conversation_query)
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
				if view:
					selected = next(
						(i for i, e in enumerate(view) if e.session_id == current_id), 0
					)
					rows, entry_to_row = build_display_rows(view)
					selected_row = entry_to_row[selected]
					if selected_row < top:
						top = selected_row
					elif selected_row >= top + max_rows:
						top = max(0, selected_row - max_rows + 1)
					top = min(top, max(0, len(rows) - max_rows))
				else:
					selected = 0
					top = 0
				continue
			if key == "enter":
				if not view:
					continue
				return PickerResult(action="resume", entry=view[selected])
			if key == "shift_enter":
				if not view:
					continue
				run_outside_alt_screen(open_in_tab_cb, view[selected])
				current_id = view[selected].session_id
				all_entries = refresh_entries_cb()
				if conversation_query:
					content_matches = search_conversations_cb(conversation_query)
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
				selected = (
					next((i for i, e in enumerate(view) if e.session_id == current_id), 0)
					if view
					else 0
				)
				top = 0
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
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
				selected = next((i for i, e in enumerate(view) if e.session_id == current_id), 0)
				top = 0
			elif key == "backspace":
				if query:
					query = query[:-1]
					view = apply_filter_and_sort(
						all_entries, query, favorites, show_unnamed, content_matches
					)
					selected = 0
					top = 0
			elif key.startswith("char:"):
				query += key[5:]
				view = apply_filter_and_sort(
					all_entries, query, favorites, show_unnamed, content_matches
				)
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

			rows, entry_to_row = build_display_rows(view)
			selected_row = entry_to_row[selected]
			if selected_row < top:
				top = selected_row
			elif selected_row >= top + max_rows:
				top = selected_row - max_rows + 1
			top = min(top, max(0, len(rows) - max_rows))
	finally:
		sys.stdout.write("\x1b[?1049l")
		sys.stdout.flush()


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


def run_with_spinner(label: str, fn, *args, **kwargs):
	if not sys.stdout.isatty():
		return fn(*args, **kwargs)

	stop = threading.Event()

	def spin():
		i = 0
		while not stop.is_set():
			frame = SPINNER_FRAMES[i % len(SPINNER_FRAMES)]
			print(f"\r{ORANGE}{frame}{RESET} {GRAY}{label}...{RESET}", end="", flush=True)
			time.sleep(0.08)
			i += 1
		print("\r" + (" " * (len(label) + 8)) + "\r", end="", flush=True)

	t = threading.Thread(target=spin, daemon=True)
	t.start()
	try:
		return fn(*args, **kwargs)
	finally:
		stop.set()
		t.join(timeout=0.2)


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
		"try { [Console]::Write(\"`e[3J`e[2J`e[H\") } catch {}; "
		"Clear-Host; "
		"$Host.UI.RawUI.WindowTitle = $title; "
		"Set-Location -LiteralPath $cwd; "
		"$p = Start-Process -FilePath $exe -ArgumentList @('-C', $cwd, 'resume', "
		f"'{entry.session_id}', {ps_extra}) -NoNewWindow -PassThru; "
		"while (-not $p.HasExited) { "
		"$Host.UI.RawUI.WindowTitle = $title; "
		"Start-Sleep -Milliseconds 250; "
		"$p.Refresh() "
		"}; "
		"exit $p.ExitCode"
	)


def make_new_chat_ps_command(codex_exe: str, run_cwd: str, title: str) -> str:
	ps_title = title.replace("'", "''")
	ps_exe = codex_exe.replace("'", "''")
	ps_cwd = str(run_cwd).replace("'", "''")
	ps_extra = ", ".join(f"'{arg}'" for arg in RESUME_EXTRA_ARGS)
	return (
		"$ErrorActionPreference = 'SilentlyContinue'; "
		f"$title = '{ps_title}'; "
		f"$exe = '{ps_exe}'; "
		f"$cwd = '{ps_cwd}'; "
		"try { [Console]::Write(\"`e[3J`e[2J`e[H\") } catch {}; "
		"Clear-Host; "
		"$Host.UI.RawUI.WindowTitle = $title; "
		"Set-Location -LiteralPath $cwd; "
		f"$argsList=@({ps_extra}); "
		"& $exe @argsList"
	)


def launch_ps_in_current_window(ps_command: str, run_cwd: str) -> int:
	script_body = ps_command.replace("; ", ";\n")
	temp_path = None
	try:
		with tempfile.NamedTemporaryFile(
			mode="w",
			suffix=".ps1",
			prefix="codex_run_",
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


def open_ps_in_new_tab(ps_command: str, title: str, run_cwd: str) -> bool:
	if os.name != "nt":
		print("Opening tabs is only supported on Windows Terminal.")
		return False
	wt_exe = shutil.which("wt.exe") or shutil.which("wt")
	if not wt_exe:
		print("Windows Terminal (`wt`) not found; cannot open a new tab.")
		return False
	encoded_cmd = base64.b64encode(ps_command.encode("utf-16le")).decode("ascii")
	try:
		cmd = [
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
		subprocess.Popen(cmd)
		return True
	except Exception as exc:
		print(f"Failed to open tab: {exc}")
		return False


def open_session_in_tab(entry: SessionEntry) -> bool:
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return False
	run_cwd = entry.cwd if entry.cwd and Path(entry.cwd).exists() else os.getcwd()
	ps_cmd = make_resume_ps_command(entry, codex_exe, run_cwd)
	title = entry.thread_name
	return open_ps_in_new_tab(ps_cmd, title, run_cwd)


def open_new_chat_tab(base_entry: SessionEntry | None) -> bool:
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return False
	run_cwd = (
		base_entry.cwd
		if base_entry is not None and base_entry.cwd and Path(base_entry.cwd).exists()
		else os.getcwd()
	)
	ps_cmd = make_new_chat_ps_command(codex_exe, run_cwd, "Codex New Chat")
	return open_ps_in_new_tab(ps_cmd, "Codex New Chat", run_cwd)


def open_all_favorites(entries: list[SessionEntry], favorites: set[str]) -> int:
	fav_entries = [e for e in entries if e.session_id in favorites]
	if not fav_entries:
		print("No favorites to open.")
		return 0
	opened = 0
	for entry in fav_entries:
		if open_session_in_tab(entry):
			opened += 1
	return opened


def launch_resume(entry: SessionEntry) -> int:
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return 1

	run_cwd = entry.cwd if entry.cwd and Path(entry.cwd).exists() else None
	if run_cwd is None:
		print("Selected session has no usable cwd; running from current folder.")
		run_cwd = os.getcwd()

	# Ensure picker/menu output and scrollback are removed before launching in current window.
	print(FULL_CLEAR, end="")
	sys.stdout.flush()
	set_terminal_title(entry.thread_name)
	print(
		f"Launching: {codex_exe} -C {run_cwd} resume {entry.session_id} "
		f"{' '.join(RESUME_EXTRA_ARGS)}"
	)
	print(f"Folder: {run_cwd}")

	if os.name == "nt":
		ps_cmd = make_resume_ps_command(entry, codex_exe, run_cwd)
		return launch_ps_in_current_window(ps_cmd, run_cwd)

	return subprocess.call(
		[codex_exe, "-C", run_cwd, "resume", entry.session_id, *RESUME_EXTRA_ARGS],
		cwd=run_cwd,
	)


def launch_new_chat_current(base_entry: SessionEntry | None) -> int:
	codex_exe = resolve_codex_executable()
	if not codex_exe:
		print("Could not find Codex launcher in PATH (`codex.cmd`/`codex.exe`).")
		return 1
	run_cwd = (
		base_entry.cwd
		if base_entry is not None and base_entry.cwd and Path(base_entry.cwd).exists()
		else os.getcwd()
	)
	# Ensure picker/menu output and scrollback are removed before launching in current window.
	print(FULL_CLEAR, end="")
	sys.stdout.flush()
	set_terminal_title("Codex New Chat")
	print(f"Launching: {codex_exe} {' '.join(RESUME_EXTRA_ARGS)}")
	print(f"Folder: {run_cwd}")
	if os.name == "nt":
		ps_cmd = make_new_chat_ps_command(codex_exe, run_cwd, "Codex New Chat")
		return launch_ps_in_current_window(ps_cmd, run_cwd)
	return subprocess.call([codex_exe, *RESUME_EXTRA_ARGS], cwd=run_cwd)


def print_list(
	entries: list[SessionEntry],
	show_id: bool,
	show_cwd: bool,
	favorites: set[str],
) -> None:
	ordered = apply_filter_and_sort(entries, "", favorites, show_unnamed=True)
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


def build_entries(codex_home: Path, name_filter: str) -> list[SessionEntry]:
	index_file = codex_home / "session_index.jsonl"
	sessions_root = codex_home / "sessions"
	details_cache_file = codex_home / "codex-fe-session-details-cache.json"
	entries = load_index(index_file)
	named_by_id = {e.session_id: e for e in entries}
	details_by_id = load_session_details_by_id(sessions_root, details_cache_file)
	for entry in entries:
		cwd, model, last_ts, created_ts, first_user_preview, session_file = details_by_id.get(
			entry.session_id, ("", "", "", "", "", "")
		)
		entry.cwd = cwd
		entry.model = model
		entry.session_file = session_file
		if last_ts:
			entry.updated_at = last_ts
		if created_ts:
			entry.created_at = created_ts
		# If thread name looks auto-generated from first user line, classify as unnamed.
		if first_user_preview and normalize_title(entry.thread_name) == normalize_title(first_user_preview):
			entry.is_named = False

	for sid, (
		cwd,
		model,
		last_ts,
		created_ts,
		first_user_preview,
		session_file,
	) in details_by_id.items():
		if sid in named_by_id:
			continue
		title = first_user_preview if first_user_preview else "(unnamed session)"
		entries.append(
			SessionEntry(
				session_id=sid,
				thread_name=title,
				updated_at=last_ts or created_ts,
				created_at=created_ts,
				cwd=cwd,
				model=model,
				is_named=False,
				session_file=session_file,
			)
		)

	entries = sorted(entries, key=lambda e: (e.updated_at, e.thread_name), reverse=True)
	if name_filter:
		entries = [e for e in entries if name_filter in e.thread_name.lower()]
	return entries


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
		help="When using --list, include last-used session folder.",
	)
	parser.add_argument(
		"--open-favorites",
		action="store_true",
		help="Open all favorited sessions as new Windows Terminal tabs in the current window.",
	)
	args = parser.parse_args()

	codex_home = args.codex_home.expanduser()
	index_file = codex_home / "session_index.jsonl"
	favorites_file = codex_home / "session_favorites.json"

	if not index_file.exists():
		print(f"Session index not found: {index_file}")
		return 1

	initial_filter = args.name.lower().strip()
	entries = run_with_spinner(
		"Parsing sessions", build_entries, codex_home, initial_filter
	)

	if not entries:
		print("No sessions matched.")
		return 1

	favorites = load_favorites(favorites_file)

	if args.open_favorites:
		fav_entries = [e for e in entries if e.session_id in favorites]
		opened = open_all_favorites(entries, favorites)
		print(f"Opened {opened}/{len(fav_entries)} favorite sessions in new tab(s).")
		return 0

	if args.list or not sys.stdout.isatty() or not sys.stdin.isatty():
		print_list(entries, args.show_id, args.show_cwd, favorites)
		return 0

	def refresh_entries() -> list[SessionEntry]:
		return run_with_spinner(
			"Refreshing sessions", build_entries, codex_home, initial_filter
		)

	def search_conversations(query_text: str) -> set[str]:
		return run_with_spinner(
			"Searching conversations",
			search_sessions_by_content,
			codex_home / "sessions",
			query_text,
		)

	selection = interactive_pick(
		entries,
		favorites_file,
		open_session_in_tab,
		open_new_chat_tab,
		open_all_favorites,
		refresh_entries,
		search_conversations,
	)
	if selection is None:
		print("Cancelled.")
		return 0
	if selection.action == "resume" and selection.entry is not None:
		return launch_resume(selection.entry)
	if selection.action == "new_chat_current":
		return launch_new_chat_current(selection.entry)
	print("No action selected.")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
