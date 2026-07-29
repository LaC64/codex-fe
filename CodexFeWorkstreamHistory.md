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

## 2026-07-28 - Terminal Selection Copy

- Made `Ctrl+C` copy selected host-terminal text instead of forwarding an interrupt to Codex.
- Preserved normal PowerShell interrupt behavior when no terminal text is selected.
- Added `Ctrl+V` clipboard paste through xterm so hosted terminals match normal PowerShell terminal behavior.
- Removed the redundant programmatic paste path after Chromium and xterm were both inserting the same clipboard text.
- Suppressed raw `Ctrl+V` terminal encoding while retaining xterm's single native paste event, preventing Codex from interpreting text paste as image paste.

## 2026-07-28 - Unique Sessions And PowerShell Tabs

- Changed existing-session selection to focus the matching host tab instead of opening a duplicate.
- Added startup normalization that collapses previously saved duplicate session tabs while preserving the active duplicate when possible.
- Added a `+` tab-bar button for standalone, persisted PowerShell tabs that do not launch Codex.

## 2026-07-29 - Existing Tab Session Relaunch

- Added ephemeral per-PTY Codex-running state while keeping persisted tab identity in `codex-fe-tabs.json`.
- Added a hidden, streaming-safe PowerShell exit marker so the host knows when managed Codex has returned to the shell prompt.
- Changed existing-session selection to resume Codex in that tab when it is at PowerShell, while continuing to only focus the tab when Codex is still running.
- Added split-marker unit coverage and a live regression sequence that verifies the same tab launches managed Codex twice after the first process exits.
