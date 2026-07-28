# Codex-FE Workstream History

## 2026-07-28 - Persistent Workspace Dashboard

- Replaced manual workspace restore as the normal workflow with a persistent Codex-FE dashboard in a named Windows Terminal window.
- Plain `codex-fe` now starts or focuses that dashboard and restores saved sessions automatically after the managed window is closed.
- Kept workspace state in `~/.codex/codex-fe-workspace.json`, archived the prior history-only workspace format during migration, and added explicit dashboard removal with `Alt+d`.
- Preserved `--restore` and `--restore-picker` as compatibility aliases for the dashboard launcher.
- Fixed an empty dashboard filter being passed as a bare `--name` argument by omitting the option when no filter is set.

## 2026-07-28 - Electron Terminal Prototype

- Added an isolated Electron proof of concept using xterm.js and node-pty/ConPTY.
- Hosted a real interactive PowerShell terminal inside a Chromium window to validate the future managed-tab architecture.
- Corrected the renderer's xterm asset paths so the terminal frontend initializes and connects to ConPTY.

## 2026-07-28 - Managed Terminal Host

- Removed Python-owned workspace restoration and returned Codex-FE to a stateless picker.
- Promoted the Electron prototype to `codex-fe-host`, with multiple ConPTY tabs and atomic browser-style tab persistence.
- Added authenticated localhost commands so picker actions lazily start the host and open existing or new Codex sessions.
- Added pending new-chat resolution, title refresh, legacy state archival, tab close persistence, and direct host restoration.
- Verified the Windows Electron/ConPTY lifecycle with an isolated integration test covering duplicate tabs, active-tab removal, clean shutdown, and exact surviving-tab restoration.
