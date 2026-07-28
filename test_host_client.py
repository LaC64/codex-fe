import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("codex-fe.py")
SPEC = importlib.util.spec_from_file_location("codex_fe_host_client_test", MODULE_PATH)
CODEX_FE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CODEX_FE
SPEC.loader.exec_module(CODEX_FE)


class HostClientTests(unittest.TestCase):
	def test_session_selection_sends_metadata_only(self):
		entry = CODEX_FE.SessionEntry(
			session_id="session-id",
			thread_name="Session Name",
			updated_at="",
			created_at="",
			cwd=str(Path.cwd()),
			model="gpt-test",
			is_named=True,
			session_file="",
		)
		with patch.object(CODEX_FE, "send_host_command", return_value=True) as send:
			self.assertTrue(CODEX_FE.send_session_to_host(entry, Path.home() / ".codex"))
		payload = send.call_args.args[1]
		self.assertEqual(payload["type"], "open_session")
		self.assertEqual(payload["session_id"], "session-id")
		self.assertEqual(payload["title"], "Session Name")
		self.assertNotIn("tabs", payload)

	def test_source_has_no_python_restore_or_windows_terminal_path(self):
		source = MODULE_PATH.read_text(encoding="utf-8")
		for forbidden in (
			"WorkspaceTab",
			"--restore",
			"restore_workspace",
			"open_ps_in_new_tab",
			"wt.exe",
		):
			self.assertNotIn(forbidden, source)


if __name__ == "__main__":
	unittest.main()
