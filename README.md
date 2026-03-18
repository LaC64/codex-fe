# Codex CLI Front End

Intended to replace the default `codex resume` front-end picker.

Interactive terminal picker for Codex sessions with:

- No need to switch to session folder to resume
- Arrow-key navigation
- Live type-to-filter
- Favorites (pin/unpin) with persistence
- Resume selected session in its original folder
- Open selected/favorite sessions in new Windows Terminal tabs
- Chat title and tab color support

## Important Behavior

- This is a front end for `codex resume`.
- It only shows sessions that have an explicit thread name in Codex's session index (for example, sessions named via `/rename`).

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

List mode:

```powershell
.\codex-fe.cmd --list --show-cwd
```

Open all favorites in new tabs:

```powershell
.\codex-fe.cmd --open-favorites
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

## Picker Controls

- `Up/Down`, `PageUp/PageDown`, `Home/End` navigate
- `Enter` resume in current tab
- `Shift+Enter` open selected session in a new Windows Terminal tab
- Type to filter
- `Backspace` remove filter text
- `Ctrl+F` or `*` toggle favorite
- `q` quit

## Notes

- Favorites are stored in `~/.codex/session_favorites.json`.
- Sessions are resumed by `session_id` for reliability.
- Resume launches use:
  - `--dangerously-bypass-approvals-and-sandbox`
