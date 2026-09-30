"""Provider-neutral session records and Claude Code transcript indexing."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CLAUDE_CACHE_VERSION = 2


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
	provider: str = "codex"
	provider_home: str = ""

	@property
	def identity(self) -> str:
		return f"{self.provider}:{self.session_id}"


def claude_home_default() -> Path:
	return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def claude_transcripts(home: Path):
	# Only root conversations: subagents and orphaned filenames are not resumable sessions.
	for file in (home / "projects").glob("*/*.jsonl"):
		try:
			uuid.UUID(file.stem)
		except ValueError:
			continue
		yield file


def message_text(record: dict[str, Any]) -> str:
	if record.get("isSidechain") or record.get("type") not in ("user", "assistant"):
		return ""
	message = record.get("message")
	if not isinstance(message, dict):
		return ""
	content = message.get("content", "")
	if isinstance(content, str):
		return content
	if not isinstance(content, list):
		return ""
	return " ".join(
		part["text"] for part in content
		if isinstance(part, dict) and part.get("type") == "text"
		and isinstance(part.get("text"), str)
	)


def apply_claude_record(state: dict[str, Any], record: dict[str, Any], session_id: str) -> None:
	"""Project metadata from main-conversation records; bookkeeping never advances age."""
	if record.get("isSidechain") or record.get("sessionId", session_id) != session_id:
		return
	kind = record.get("type")
	if kind == "custom-title":
		state["custom_title"] = str(record.get("customTitle") or "").strip()
	elif kind == "ai-title":
		state["ai_title"] = str(record.get("aiTitle") or "").strip()
	elif kind == "system" and record.get("subtype") == "local_command":
		command = record.get("commandRun")
		if (isinstance(command, dict) and command.get("command") == "rename"
			and isinstance(command.get("args"), str)
			and str(record.get("content") or "").startswith("<local-command-stdout>Session renamed to:")):
			state["rename_title"] = command["args"].strip()
	if kind not in ("user", "assistant"):
		return
	message = record.get("message")
	if not isinstance(message, dict):
		return
	state["has_messages"] = True
	timestamp = str(record.get("timestamp") or "")
	if timestamp:
		state["created_at"] = min(state.get("created_at") or timestamp, timestamp)
		if timestamp >= state.get("updated_at", ""):
			state["updated_at"] = timestamp
			if record.get("cwd"):
				state["cwd"] = str(record["cwd"])
	elif not state.get("cwd") and record.get("cwd"):
		state["cwd"] = str(record["cwd"])
	if kind == "assistant" and message.get("model"):
		state["model"] = str(message["model"])
	text = message_text(record)
	if kind == "user" and text and not state.get("preview"):
		state["preview"] = " ".join(text.split())[:360]


def prefix_signature(handle, offset: int) -> str:
	"""Bounded probes detect replacements without rereading unchanged transcript bodies."""
	digest = hashlib.sha256()
	for position in sorted({0, max(0, offset // 2 - 128), max(0, offset - 256)}):
		handle.seek(position)
		digest.update(handle.read(min(256, max(0, offset - position))))
	return digest.hexdigest()


def load_claude_entries(home: Path, cache_file: Path) -> list[SessionEntry]:
	"""Cache complete JSONL offsets; appended partial records are retried next refresh."""
	try:
		cache = json.loads(cache_file.read_text(encoding="utf-8"))
		cache = cache.get("files", {}) if cache.get("version") == CLAUDE_CACHE_VERSION else {}
		if not isinstance(cache, dict):
			cache = {}
	except (OSError, ValueError, AttributeError):
		cache = {}
	updated_cache = {}
	entries = []
	for file in claude_transcripts(home):
		try:
			stat = file.stat()
			old = cache.get(str(file))
			if not isinstance(old, dict):
				old = {}
			state = old.get("state")
			with file.open("rb") as handle:
				offset = old.get("offset", 0)
				valid = (
					isinstance(state, dict) and isinstance(offset, int)
					and 0 <= offset <= stat.st_size
					and old.get("inode") == stat.st_ino
					and old.get("ctime_ns") == stat.st_ctime_ns
					and old.get("signature") == prefix_signature(handle, offset)
					and (old.get("size", -1) < stat.st_size
						or old.get("mtime_ns") == stat.st_mtime_ns)
				)
				if not valid:
					state, offset = {}, 0
				handle.seek(offset)
				while handle.tell() < stat.st_size:
					position = handle.tell()
					line = handle.readline(stat.st_size - position)
					if not line.endswith(b"\n"):
						break
					offset = handle.tell()
					try:
						record = json.loads(line)
						if isinstance(record, dict):
							apply_claude_record(state, record, file.stem)
					except (ValueError, UnicodeDecodeError):
						continue
				updated_cache[str(file)] = {
					"size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
					"inode": stat.st_ino, "ctime_ns": stat.st_ctime_ns,
					"offset": offset, "signature": prefix_signature(handle, offset),
					"state": state,
				}
			if not state.get("has_messages"):
				continue
			entries.append(SessionEntry(
				session_id=file.stem,
				thread_name=state.get("rename_title") or state.get("custom_title") or state.get("ai_title")
					or state.get("preview") or "(unnamed session)",
				updated_at=state.get("updated_at", ""),
				created_at=state.get("created_at", ""),
				cwd=state.get("cwd", ""), model=state.get("model", ""),
				is_named=bool(state.get("rename_title") or state.get("custom_title")),
				session_file=str(file), provider="claude", provider_home=str(home),
			))
		except OSError:
			continue
	if updated_cache != cache:
		try:
			cache_file.parent.mkdir(parents=True, exist_ok=True)
			temporary = cache_file.with_name(f"{cache_file.name}.{os.getpid()}.tmp")
			temporary.write_text(json.dumps({"version": CLAUDE_CACHE_VERSION, "files": updated_cache}), encoding="utf-8")
			temporary.replace(cache_file)
		except OSError:
			pass
	return entries


def search_claude_sessions(home: Path, query: str) -> set[str]:
	matches = set()
	for file in claude_transcripts(home):
		try:
			with file.open("r", encoding="utf-8", errors="replace") as handle:
				for line in handle:
					if query.lower() not in line.lower():
						continue
					try:
						record = json.loads(line)
						if isinstance(record, dict) and query.lower() in message_text(record).lower():
							matches.add(f"claude:{file.stem}")
							break
					except ValueError:
						continue
		except OSError:
			continue
	return matches
