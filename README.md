# Codex CLI Front End

Meant to replace Codexs CLI's Front End

Interactive terminal picker for Codex sessions with:

- No need to switch to session folder to resume
- Arrow-key navigation
- Live type-to-filter
- Favorites (pin/unpin) with persistence
- Resume selected session in its original folder
- Open selected/favorite sessions in new Windows Terminal tabs
- Chat title and tab color support

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
