# Codex CLI Front End

Intended to replace the default `codex resume` front-end picker.

Interactive terminal picker for Codex sessions with:

- No need to switch to session folder to resume
- Arrow-key navigation
- Live type-to-filter
- Favorites (pin/unpin) with persistence
- Optional unnamed-session view toggle
- Resume selected session in its last-used folder
- Open selected/favorite sessions in new Windows Terminal tabs
- Persistent Windows Terminal workspace with automatic session restore
- Chat title and tab color support
- Cached session metadata for fast startup

## Important Behavior

- This is a front end for `codex resume`.
- Named sessions are shown by default.
- Unnamed sessions can be included in the picker with `Alt+a`.

## Files

- `codex-fe.py` - main picker script
- `codex-fe.cmd` - Windows launcher

## Requirements

- Windows (PowerShell + optional Windows Terminal `wt`)
- Python 3.10+
- Codex CLI installed and on `PATH`

## Usage

From this folder:

```powershell
.\codex-fe.cmd
```

This opens the persistent Codex-FE dashboard in a named Windows Terminal window. After a reboot or closing that window, it automatically restores the saved Codex session tabs; no `--restore` command is needed.

List mode:

```powershell
.\codex-fe.cmd --list --show-cwd
```

Open all favorites in new tabs:

```powershell
.\codex-fe.cmd --open-favorites
```

`--restore` and `--restore-picker` remain accepted as compatibility aliases, but both now open the persistent dashboard:

```powershell
.\codex-fe.cmd --restore
```

## Run From Anywhere (Recommended)

Put the folder containing `codex-fe.cmd` on your user `PATH` so you can run `codex-fe` from any directory.

PowerShell (run once):

```powershell
$toolPath = "E:\GitHub\codex-fe"
$current = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $current) { $current = "" }
if ($current -notlike "*$toolPath*") {
	[Environment]::SetEnvironmentVariable(
		"Path",
		($current.TrimEnd(";") + ";" + $toolPath).Trim(";"),
		"User"
	)
}
```

Then open a new terminal and verify:

```powershell
where.exe codex-fe
codex-fe --list
```

## Dashboard Controls

- Action shortcuts use `Alt+...` so normal typing is reserved for the filter.
- `Up/Down`, `PageUp/PageDown`, `Home/End` navigate
- `Enter` open the selected session in a new managed Windows Terminal tab
- Type to filter
- `Backspace` remove filter text
- `Alt+a` toggle unnamed session visibility
- `Alt+d` remove the selected session from the saved workspace
- `Alt+r` refresh sessions
- `Alt+n` or `Alt+N` start a new managed chat tab
- `Alt+Shift+O` open all favorites in new tabs
- `Ctrl+P` copy the selected conversation JSONL file path
- `Ctrl+F` or `*` toggle favorite
- `Alt+q` quit

## Persistent Workspace

Codex-FE keeps a dedicated dashboard as the first tab in a named Windows Terminal window. The dashboard owns the saved workspace and remains open while sessions are launched in adjacent tabs.

- Running `codex-fe` restores all resolved saved sessions automatically after the managed terminal window has been closed.
- Running `codex-fe` while the dashboard is already running focuses that dashboard instead of restoring duplicate tabs.
- `Alt+d` in the dashboard is the explicit way to remove a session from the next restore.
- `codex-fe --workspace-status` lists saved sessions and pending new chats.
- `codex-fe --clear-workspace` clears the saved workspace.

New chats are saved as pending entries first. Codex-FE tries to resolve them to the real session id after Codex writes the session file; ambiguous matches stay pending instead of restoring the wrong conversation. Closing an individual Windows Terminal tab does not change the saved workspace; remove it explicitly from the dashboard when it should no longer return.

Older workspace files are migrated safely: their historical entries are retained as archived legacy records but are not auto-restored, because the previous format tracked every session ever launched rather than one live set of terminal tabs.

## Notes

- Favorites are stored in `~/.codex/session_favorites.json`.
- Cached session metadata is stored in `~/.codex/codex-fe-session-details-cache.json`.
- Workspace state is stored in `~/.codex/codex-fe-workspace.json`.
- The active dashboard marker is stored in `~/.codex/codex-fe-dashboard.json` while the dashboard is running.
- Workspace restore only tracks tabs launched through Codex-FE.
- Sessions are resumed by `session_id` for reliability.
- Resume launches use:
  - `--dangerously-bypass-approvals-and-sandbox`
