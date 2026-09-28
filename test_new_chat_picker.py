import contextlib
import io
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from test_host_client import CODEX_FE


class TerminalOutput(io.StringIO):
	def isatty(self):
		return True


class NewChatPickerTests(unittest.TestCase):
	def setUp(self):
		self.temporary = tempfile.TemporaryDirectory()
		self.addCleanup(self.temporary.cleanup)
		self.home = Path(self.temporary.name)
		self.claude_home = self.home / "claude-config"
		self.claude_home.mkdir()
		self.codex = CODEX_FE.SessionEntry(
			"codex-id", "Codex test", "", "", str(self.home), "", True, "",
		)
		self.claude = replace(self.codex, session_id="claude-id", thread_name="Claude test",
			provider="claude", provider_home=str(self.claude_home))
		self.new_chat = Mock(return_value=True)
		self.output = TerminalOutput()

	# Exercise the real menu and chooser while isolating terminal I/O and host requests.
	def terminal_patches(self, stack, keys):
		stack.enter_context(patch.object(CODEX_FE.sys, "stdout", self.output))
		stack.enter_context(patch.object(CODEX_FE, "get_key", side_effect=keys))
		stack.enter_context(patch.object(CODEX_FE.os, "get_terminal_size",
			return_value=os.terminal_size((160, 60))))

	def pick(self, entries, keys):
		with contextlib.ExitStack() as stack:
			self.terminal_patches(stack, keys)
			return CODEX_FE.interactive_pick(entries, self.home / "favorites.json",
				Mock(), self.new_chat, Mock(), lambda: entries, Mock())

	def test_alt_n_defaults_to_claude_despite_highlighted_codex(self):
		result = self.pick([self.codex], ["new_chat_current", "enter"])
		self.assertEqual(result.provider, "claude")
		self.assertEqual(result.entry, self.codex)
		self.assertEqual(result.action, "new_chat_current")
		self.assertIn(CODEX_FE.ORANGE + "> CL  Claude", self.output.getvalue())
		self.assertIn("Folder: " + str(self.home), self.output.getvalue())

	def test_arrows_can_choose_codex_from_claude_row(self):
		result = self.pick([self.claude], ["new_chat_current", "down", "enter"])
		self.assertEqual(result.provider, "codex")
		self.assertEqual(result.entry, self.claude)
		self.assertIn(CODEX_FE.BLUE + "> CX  Codex", self.output.getvalue())

	def test_arrow_wraparound_and_home_end(self):
		for keys, expected in ((["up", "enter"], "codex"),
			(["down", "down", "enter"], "claude"),
			(["end", "home", "shift_enter"], "claude")):
			with self.subTest(keys=keys):
				result = self.pick([self.codex], ["new_chat_current", *keys])
				self.assertEqual(result.provider, expected)

	def test_cancel_preserves_filter_and_does_not_launch(self):
		result = self.pick([self.codex, self.claude],
			["char:x", "new_chat_current", "esc", "enter"])
		self.assertEqual(result.action, "resume")
		self.assertEqual(result.entry, self.codex)
		self.new_chat.assert_not_called()
		self.assertIn(CODEX_FE.GRAY + "x", self.output.getvalue())

	def test_cancel_preserves_highlighted_row(self):
		entries = [self.codex, self.claude]
		expected = CODEX_FE.apply_filter_and_sort(entries, "", set(), False)[1]
		result = self.pick(entries, ["down", "new_chat_current", "esc", "enter"])
		self.assertEqual(result.entry, expected)

	def test_cancel_shifted_shortcut_and_return_to_picker(self):
		result = self.pick([], ["new_chat_tab", "esc", "quit"])
		self.assertIsNone(result)
		self.new_chat.assert_not_called()

	def test_shifted_shortcut_keeps_picker_open_and_resets_to_claude(self):
		result = self.pick([self.codex], ["new_chat_tab", "down", "enter",
			"new_chat_tab", "enter", "quit"])
		self.assertIsNone(result)
		self.assertEqual(self.new_chat.call_args_list[0].args, (self.codex, "codex"))
		self.assertEqual(self.new_chat.call_args_list[1].args, (self.codex, "claude"))

	def test_empty_picker_still_defaults_to_claude(self):
		result = self.pick([], ["new_chat_current", "enter"])
		self.assertEqual(result.provider, "claude")
		self.assertIsNone(result.entry)

	def test_explicit_provider_controls_payload_and_config_home(self):
		for entry, provider, expected_home in ((self.codex, "claude", str(self.claude_home)),
			(self.claude, "codex", ""), (self.claude, "claude", str(self.claude_home)),
			(None, "claude", str(self.claude_home))):
			with self.subTest(provider=provider, entry=entry):
				with patch.object(CODEX_FE, "send_host_command", return_value=True) as send:
					CODEX_FE.send_new_chat_to_host(entry, self.home, provider, self.claude_home)
				payload = send.call_args.args[1]
				self.assertEqual(payload["provider"], provider)
				self.assertEqual(payload["provider_home"], expected_home)
				self.assertEqual(payload["cwd"], str(self.home) if entry else os.getcwd())
				self.assertEqual(payload["title"], f"{provider.title()} New Chat")

	def test_missing_folder_falls_back_and_invalid_provider_never_launches(self):
		entry = replace(self.codex, cwd=str(self.home / "missing"))
		with patch.object(CODEX_FE, "send_host_command", return_value=True) as send:
			CODEX_FE.send_new_chat_to_host(entry, self.home, "claude", self.claude_home)
			self.assertEqual(send.call_args.args[1]["cwd"], os.getcwd())
			send.reset_mock()
			with self.assertRaises(ValueError):
				CODEX_FE.send_new_chat_to_host(entry, self.home, "all", self.claude_home)
			send.assert_not_called()

	def test_main_forwards_chooser_result_on_both_shortcuts_regardless_of_list_filter(self):
		for list_filter, entries, action, choice_keys, expected in (
			("all", [self.codex], "new_chat_current", ["enter"], "claude"),
			("claude", [self.claude], "new_chat_current", ["down", "enter"], "codex"),
			("codex", [self.codex], "new_chat_tab", ["down", "enter"], "codex"),
			("codex", [], "new_chat_tab", ["enter"], "claude"),
		):
			with self.subTest(list_filter=list_filter, action=action):
				keys = [action, *choice_keys] + (["quit"] if action == "new_chat_tab" else [])
				with contextlib.ExitStack() as stack:
					self.terminal_patches(stack, keys)
					stack.enter_context(patch.object(CODEX_FE.sys, "argv", ["codex-fe",
						"--provider", list_filter, "--codex-home", str(self.home),
						"--claude-home", str(self.claude_home)]))
					stack.enter_context(patch.object(CODEX_FE.sys.stdin, "isatty", return_value=True))
					stack.enter_context(patch.object(CODEX_FE, "run_with_spinner", return_value=entries))
					send = stack.enter_context(patch.object(CODEX_FE, "send_host_command", return_value=True))
					self.assertEqual(CODEX_FE.main(), 0)
					send.assert_called_once()
					self.assertEqual(send.call_args.args[1]["provider"], expected)


if __name__ == "__main__":
	unittest.main()
