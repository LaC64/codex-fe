# Codex CLI Front End

Codex-FE provides one session picker for Codex CLI and Claude Code and opens selected conversations in a managed Electron terminal host.

## Features

- Find named and unnamed Codex and Claude sessions without changing folders
- Navigate with arrow keys and filter by typing
- Persist favorites
- Resume sessions in their last-used folders
- Open PowerShell, Codex, and Claude sessions in managed Chromium tabs
- Reuse an already-open tab when the same provider/session is selected again
- Open standalone PowerShell tabs from the host tab bar
- Restore exactly the host tabs that were open when the app closed
- Remove a session from future restoration by closing its host tab
- Preserve chat titles, models, and full-trust startup for both providers

Only explicitly named sessions are considered named: Codex `/rename`, or Claude `/rename` and `--name`. Use `Alt+a` to include unnamed sessions, including Claude's automatically generated AI titles. Explicit Claude names take precedence over generated titles.

The picker shows a Provider column: blue `CX` for Codex and orange `CL` for Claude. Host tabs use the same colors and labels; standalone PowerShell tabs use gray `PS`.

## Components

- `codex-fe.py` is the stateless terminal picker and session index reader.
- `codex-fe.cmd` launches the picker.
- `codex-fe-host` is the Electron/xterm.js/ConPTY application that owns PowerShell processes, tabs, and restore state.

The Python picker never stores or restores tabs. The host is the only owner of `~/.codex/codex-fe-tabs.json`.

## Requirements

- Windows 10/11 with ConPTY
- Python 3.10+
- Node.js and npm
- Codex CLI and/or Claude Code installed and authenticated on `PATH`; use Claude Code 2.1.223+ for [resuming a session UUID across project folders](https://code.claude.com/docs/en/cli-reference)

Install the host dependencies after cloning:

```powershell
cd C:\path\to\codex-fe\codex-fe-host
npm install
```

For global use, add the repository folder containing `codex-fe.cmd` to your user `PATH`:

```powershell
$codexFeDir = (Resolve-Path "C:\path\to\codex-fe").Path
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $codexFeDir) {
	[Environment]::SetEnvironmentVariable(
		"Path",
		($userPath.TrimEnd(";") + ";" + $codexFeDir),
		"User"
	)
}
```

Open a new terminal after changing `PATH`. `codex-fe-host\start.cmd` also installs missing dependencies before launching the host. Normal picker use starts the host automatically after a session is selected.

## Usage

Run the picker:

```powershell
codex-fe
```

Limit the picker to one provider:

```powershell
codex-fe --provider claude
codex-fe --provider codex
```

The default is `--provider all`. Claude sessions are read from `CLAUDE_CONFIG_DIR` or `%USERPROFILE%\.claude`; override this with `--claude-home C:\path\to\claude-config`. `--codex-home` still controls the Codex session source and the shared host workspace.

The default Claude data folder does not set `CLAUDE_CONFIG_DIR` when launching Claude, so it continues using your existing `%USERPROFILE%\.claude.json` configuration. Non-default homes and explicitly inherited `CLAUDE_CONFIG_DIR` settings still use the requested custom configuration directory. FE does not copy or replace Claude configuration files.

List mode:

```powershell
codex-fe --list --show-cwd
```

Open all favorites in the host:

```powershell
codex-fe --open-favorites
```

Launch the host directly and restore its saved tabs:

```powershell
codex-fe-host\start.cmd
```

## Picker Controls

- `Up/Down`, `PageUp/PageDown`, `Home/End` navigate
- `Enter` open the selected session in the host and exit the picker
- `Shift+Enter` open the selected session and keep the picker open
- Type to filter; `Backspace` removes filter text
- `Alt+a` toggle unnamed session visibility
- `Alt+r` refresh sessions
- `Alt+n` choose Claude or Codex for a new chat, then exit the picker after starting it
- `Alt+Shift+N` use the same new-chat chooser, keeping the picker open after starting it
- `Alt+s` enter a conversation-content search across the displayed providers
- `Alt+Shift+O` open all favorites in host tabs
- `Ctrl+P` copy the selected conversation JSONL path
- `Ctrl+F` or `*` toggle favorite
- `Alt+q` quit

The new-chat chooser defaults to Claude every time. Use `Up/Down` to select Claude or Codex, `Enter` to start, or `Esc` to return to the picker without launching anything. New chats use the highlighted session's folder, or the current folder when no session is highlighted. The provider choice is independent of the highlighted session and `--provider` list filter, so both providers remain available even with no saved sessions.

## Host Behavior

- Every visible host tab has a stable tab ID, and each `(provider, session ID)` maps to at most one tab.
- Selecting an already-open session focuses its existing tab instead of starting another process.
- If the agent has exited to that tab's PowerShell prompt, selecting the session resumes the agent again in the same tab.
- The `+` button opens a standalone PowerShell tab.
- The monochrome orange robot button opens the Codex-FE session picker in a temporary tab.
- The picker tab closes after the picker exits and is not added to `Ctrl+Shift+T` history. Selecting a session leaves the selected or existing session tab active.
- Drag tabs to reorder them; the order is saved and restored with the workspace.
- Tabs can grow to `520px` wide and wrap into additional header rows instead of using horizontal scrolling.
- Terminal rows remain fully visible as wrapped tab rows change the available terminal height.
- Closing one tab removes it immediately from the saved workspace.
- `Ctrl+Shift+T` reopens the most recently closed tab. Repeated presses restore older tabs in reverse close order.
- Closed-tab history persists across host restarts and retains the 50 most recently closed tabs.
- Closing the host application preserves its remaining tab list.
- Closing a maximized host remembers that state and restores the next host window maximized.
- Reopening the host resumes every saved Codex and Claude session in the same order.
- `Ctrl+Tab` and `Ctrl+Shift+Tab` switch tabs.
- `Ctrl+W` closes the active tab.
- `Ctrl+C` copies selected terminal text; with no selection it still interrupts the running command.
- `Ctrl+V` pastes clipboard text through the active terminal.
- A tab's `CX`, `CL`, or `PS` marker becomes a Braille spinner while its terminal is producing output, retaining its provider color.
- New Codex chats resolve their session IDs when the session JSONL appears. New Claude chats start with an assigned UUID and use that exact ID on restoration.
- Terminal scrollback is not persisted; each conversation is resumed by its provider and session ID.

On the first host launch, the removed Python dashboard files `codex-fe-workspace.json` and `codex-fe-dashboard.json` are renamed with `.legacy-<timestamp>` and ignored. They are not imported, so the managed host begins with a clean tab list.

Favorites remain in `~/.codex/session_favorites.json`, keyed by provider and session ID. Existing UUID-only favorites and tabs without a provider migrate to Codex automatically. Codex metadata is cached in `codex-fe-session-details-cache.json`; Claude metadata is cached in `codex-fe-claude-details-cache.json` in the same Codex home. Claude caching reads only complete appended records after the initial scan and reparses changed or replaced files.

New and resumed Codex sessions launch with `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`.

New and resumed Claude sessions launch with `--dangerously-skip-permissions`. Claude keeps its own terminal display behavior; Codex's `--no-alt-screen` is not passed to Claude. Both providers use their existing CLI authentication, settings, and project instructions.

To override executable discovery, set `CODEX_FE_CODEX_EXE` or `CODEX_FE_CLAUDE_EXE` to the corresponding executable or CMD launcher path.
