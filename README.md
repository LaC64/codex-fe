# Codex CLI Front End

Codex-FE replaces the default `codex resume` picker and opens selected conversations in a managed Electron terminal host.

## Features

- Find named and unnamed Codex sessions without changing folders
- Navigate with arrow keys and filter by typing
- Persist favorites
- Resume sessions in their last-used folders
- Open PowerShell/Codex sessions in managed Chromium tabs
- Restore exactly the host tabs that were open when the app closed
- Remove a session from future restoration by closing its host tab
- Preserve chat titles, models, and full-trust Codex startup

Only sessions explicitly renamed with `/rename` are considered named. Use `Alt+a` to include unnamed sessions whose title is derived from their first message.

## Components

- `codex-fe.py` is the stateless terminal picker and session index reader.
- `codex-fe.cmd` launches the picker.
- `codex-fe-host` is the Electron/xterm.js/ConPTY application that owns PowerShell processes, tabs, and restore state.

The Python picker never stores or restores tabs. The host is the only owner of `~/.codex/codex-fe-tabs.json`.

## Requirements

- Windows 10/11 with ConPTY
- Python 3.10+
- Node.js and npm
- Codex CLI installed and on `PATH`

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
- `Alt+n` start a new hosted chat and exit the picker
- `Alt+N` start a new hosted chat and keep the picker open
- `Alt+Shift+O` open all favorites in host tabs
- `Ctrl+P` copy the selected conversation JSONL path
- `Ctrl+F` or `*` toggle favorite
- `Alt+q` quit

## Host Behavior

- Every visible host tab has a stable tab ID, so duplicate tabs for the same Codex session are supported.
- Closing one tab removes it immediately from the saved workspace.
- Closing the host application preserves its remaining tab list.
- Reopening the host resumes every saved Codex session in the same order.
- `Ctrl+Tab` and `Ctrl+Shift+Tab` switch tabs.
- `Ctrl+W` closes the active tab.
- `Ctrl+C` copies selected terminal text; with no selection it still interrupts the running command.
- New chats begin as pending tabs and are updated with their generated Codex session ID once the session JSONL appears.
- Terminal scrollback is not persisted; the Codex conversation itself is resumed by session ID.

On the first host launch, the removed Python dashboard files `codex-fe-workspace.json` and `codex-fe-dashboard.json` are renamed with `.legacy-<timestamp>` and ignored. They are not imported, so the managed host begins with a clean tab list.

Favorites remain in `~/.codex/session_favorites.json`. Cached session metadata remains in `~/.codex/codex-fe-session-details-cache.json`.

Codex launches use `--dangerously-bypass-approvals-and-sandbox`.
