import io
import json
import os
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import session_providers as providers
from test_host_client import CODEX_FE


class ClaudeSessionTests(unittest.TestCase):
	def setUp(self):
		self.temporary = tempfile.TemporaryDirectory()
		self.addCleanup(self.temporary.cleanup)
		self.home = Path(self.temporary.name)
		self.cache = self.home / "cache.json"
		self.session_id = str(uuid.uuid4())
		self.project = self.home / "projects" / "encoded-folder"
		self.project.mkdir(parents=True)
		self.file = self.project / f"{self.session_id}.jsonl"

	def write(self, *rows, mode="w"):
		with self.file.open(mode, encoding="utf-8") as handle:
			for row in rows:
				handle.write(json.dumps({"sessionId": self.session_id, **row}) + "\n")

	def message(self, text="A snap example", kind="user", timestamp="2026-09-27T12:00:00Z", **extra):
		return {"type": kind, "cwd": str(self.home), "timestamp": timestamp,
			"message": {"content": [{"type": "text", "text": text}], "model": "claude-test"}, **extra}

	def load(self):
		return providers.load_claude_entries(self.home, self.cache)

	def test_explicit_name_wins_over_generated_title_and_bookkeeping_age(self):
		self.write(self.message(), {"type": "custom-title", "customTitle": "Renamed"},
			{"type": "ai-title", "aiTitle": "Generated"},
			self.message(kind="assistant", timestamp="2026-09-27T13:00:00Z", cwd="D:\\last folder"),
			{"type": "system", "timestamp": "2026-09-28T01:00:00Z"})
		entry = self.load()[0]
		self.assertTrue(entry.is_named)
		self.assertEqual(entry.thread_name, "Renamed")
		self.assertEqual(entry.cwd, "D:\\last folder")
		self.assertEqual(entry.updated_at, "2026-09-27T13:00:00Z")
		self.assertEqual(entry.created_at, "2026-09-27T12:00:00Z")
		self.assertEqual(entry.model, "claude-test")
		self.assertEqual(entry.session_file, str(self.file))

	def test_ai_titles_remain_unnamed(self):
		self.write(self.message(), {"type": "ai-title", "aiTitle": "Generated"})
		entry = self.load()[0]
		self.assertFalse(entry.is_named)
		self.assertEqual(entry.thread_name, "Generated")
		self.assertEqual(CODEX_FE.apply_filter_and_sort([entry], "", set(), False), [])
		self.assertEqual(len(CODEX_FE.apply_filter_and_sort([entry], "", set(), True)), 1)

	def test_main_user_preview_excludes_tool_results_and_sidechains(self):
		self.write(self.message("wrong", isSidechain=True),
			{"type": "user", "message": {"content": [{"type": "tool_result", "content": "tool secret"}]}},
			self.message("A real prompt"))
		self.assertEqual(self.load()[0].thread_name, "A real prompt")
		self.assertEqual(providers.search_claude_sessions(self.home, "tool secret"), set())

	def test_subagents_orphans_and_metadata_stubs_are_excluded(self):
		self.write({"type": "ai-title", "aiTitle": "Stub"})
		(self.project / "subagents").mkdir()
		(self.project / "subagents" / f"{uuid.uuid4()}.jsonl").write_text(json.dumps(self.message()) + "\n")
		(self.project / "anything.orphaned.jsonl").write_text(json.dumps(self.message()) + "\n")
		self.assertEqual(self.load(), [])

	def test_append_is_incremental_and_unchanged_file_does_not_parse(self):
		self.write(self.message())
		self.load()
		with patch.object(providers, "apply_claude_record", wraps=providers.apply_claude_record) as parse:
			self.load()
			parse.assert_not_called()
			self.write({"type": "custom-title", "customTitle": "New name"}, mode="a")
			self.assertEqual(self.load()[0].thread_name, "New name")
			self.assertEqual(parse.call_count, 1)

	def test_partial_record_is_retried_after_completion(self):
		self.write(self.message())
		self.load()
		row = json.dumps({"type": "custom-title", "customTitle": "Completed", "sessionId": self.session_id})
		with self.file.open("a", encoding="utf-8") as handle:
			handle.write(row[:30])
		self.assertFalse(self.load()[0].is_named)
		with self.file.open("a", encoding="utf-8") as handle:
			handle.write(row[30:] + "\n")
		self.assertEqual(self.load()[0].thread_name, "Completed")

	def test_rewrites_remove_stale_metadata_even_when_file_grows(self):
		self.write(self.message(), {"type": "custom-title", "customTitle": "Old"})
		self.load()
		self.write(self.message("A replacement " * 100))
		self.assertFalse(self.load()[0].is_named)
		self.write(self.message("Short"))
		self.assertEqual(self.load()[0].thread_name, "Short")

	def test_malformed_record_and_null_cache_do_not_crash(self):
		self.write(self.message())
		with self.file.open("a", encoding="utf-8") as handle:
			handle.write("{malformed}\n")
		self.cache.write_text(json.dumps({"version": 1, "files": {str(self.file): None}}))
		self.assertEqual(len(self.load()), 1)

	def test_favorites_and_content_filter_keep_provider_identity(self):
		self.write(self.message())
		claude = self.load()[0]
		codex = replace(claude, provider="codex", is_named=True)
		favorites_file = self.home / "favorites.json"
		favorites_file.write_text(json.dumps({"favorites": [self.session_id, claude.identity]}))
		favorites = CODEX_FE.load_favorites(favorites_file)
		self.assertEqual(favorites, {codex.identity, claude.identity})
		self.assertEqual(set(json.loads(favorites_file.read_text())["favorites"]), favorites)
		matches = providers.search_claude_sessions(self.home, "snap")
		self.assertEqual(matches, {claude.identity})
		self.assertEqual(CODEX_FE.apply_filter_and_sort([claude, codex], "", favorites, True, matches), [claude])

	def test_new_chat_uses_selected_provider_and_config_home(self):
		self.write(self.message())
		claude = self.load()[0]
		with patch.object(CODEX_FE, "send_host_command", return_value=True) as send:
			CODEX_FE.send_new_chat_to_host(claude, self.home, "claude")
		self.assertEqual(send.call_args.args[1]["provider"], "claude")
		self.assertEqual(send.call_args.args[1]["provider_home"], str(self.home))
		with patch.object(CODEX_FE, "send_host_command", return_value=True) as send:
			CODEX_FE.send_new_chat_to_host(None, self.home, "claude", self.home)
		self.assertEqual(send.call_args.args[1]["provider"], "claude")

	def test_claude_only_works_without_codex_index(self):
		self.write(self.message())
		self.assertEqual(len(CODEX_FE.build_entries(self.home, "", self.home, "claude")), 1)
		self.assertEqual(CODEX_FE.build_entries(self.home, "", self.home, "codex"), [])

	def test_duplicate_transcripts_keep_newest_provider_session(self):
		self.write(self.message("Original"))
		other_project = self.home / "projects" / "other-project"
		other_project.mkdir()
		(other_project / self.file.name).write_text(json.dumps({
			"sessionId": self.session_id,
			**self.message("Latest", timestamp="2026-09-28T12:00:00Z"),
		}) + "\n")
		entries = CODEX_FE.build_entries(self.home, "", self.home, "all")
		self.assertEqual(len(entries), 1)
		self.assertEqual(entries[0].thread_name, "Latest")

	def test_custom_title_buried_in_large_transcript_survives_incremental_refresh(self):
		padding = {"type": "system", "text": "x" * (1024 * 1024)}
		self.write(self.message(), padding, {"type": "custom-title", "customTitle": "In the middle"}, padding)
		self.assertEqual(self.load()[0].thread_name, "In the middle")
		self.write(self.message(kind="assistant", timestamp="2026-09-28T12:00:00Z"), mode="a")
		self.assertEqual(self.load()[0].thread_name, "In the middle")

	def test_provider_column_uses_colors_with_aligned_visible_columns(self):
		self.write(self.message(), {"type": "custom-title", "customTitle": "Example"})
		entry = self.load()[0]
		with patch.object(CODEX_FE.os, "get_terminal_size", return_value=os.terminal_size((140, 50))):
			with patch.object(CODEX_FE.sys, "stdout", new_callable=io.StringIO) as output:
				CODEX_FE.render_menu([entry, replace(entry, provider="codex")], 0, 0, "", "", set(), False)
		text = output.getvalue()
		self.assertIn(CODEX_FE.ORANGE + "CL", text)
		self.assertIn(CODEX_FE.BLUE + "CX", text)
		self.assertIn("Provider", text)
		self.assertIn("New chat: choose provider (Claude default)", text)


if __name__ == "__main__":
	unittest.main()
