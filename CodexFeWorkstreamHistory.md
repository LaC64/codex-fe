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

## 2026-07-29 - Closed Tab Restoration

- Added a persisted, 50-entry closed-tab history to the host's canonical `codex-fe-tabs.json` workspace.
- Added browser-style `Ctrl+Shift+T` restoration in last-closed-first-restored order, including when no tabs remain open.
- Kept explicit tab closure separate from application shutdown so closing the host preserves open tabs without adding them to closed-tab history.
- Prevented open tabs and duplicate session identities from remaining in closed-tab history.
- Added unit and isolated Electron integration coverage for shortcut dispatch, close/restore cycles, and restoration after a host restart.

## 2026-07-29 - Tab Add Button Placement

- Moved the new-PowerShell `+` button directly after the last visible tab instead of leaving it at the far-right edge of the tab region.
- Kept tabs and the add button in one horizontal overflow strip so the control follows the final tab when the strip scrolls.

## 2026-07-29 - Tab Activity Spinner

- Replaced each tab's orange `PS` marker with an animated Braille spinner while its PTY produces output.
- Kept activity as renderer-only state keyed by stable tab ID, with one shared animation timer and a 1.2-second idle timeout.
- Fixed the marker width so spinner frame changes do not shift tab titles.

## 2026-07-30 - Wrapping Tab Rows

- Doubled the maximum tab width from `260px` to `520px` so longer session names truncate less often.
- Replaced horizontal tab scrolling with fixed-height wrapped rows and made the terminal area account for the resulting header height.
- Kept the new-tab `+` button directly after the final tab across wrapped rows.

## 2026-07-30 - Maximized Window Restoration

- Added the host window's maximized flag to the canonical `codex-fe-tabs.json` workspace with backward-compatible normalization.
- Persisted maximize/unmaximize transitions and captured the final state again when the host closes.
- Restored the maximized state before showing the host and added live restart coverage for the complete save/restore path.

## 2026-08-20 - Wrapped Header Terminal Fit

- Fixed the bottom terminal row being clipped as wrapped tab rows reduced the terminal viewport height.
- Moved terminal padding from the FitAddon parent onto xterm itself so the padding is included in row-count calculations.
- Preserved the existing visual inset while keeping regular PowerShell prompts and Codex output fully visible.

## 2026-08-26 - Inline Codex Screen Mode

- Added `--no-alt-screen` to the shared Codex launch arguments while preserving full-trust mode.
- Applied the same argument list to both new chats and resumed sessions so Codex remains in terminal scrollback.
- Added regression coverage that requires both launch branches to use the shared options.

## 2026-09-09 - Tab Reordering And Picker Launcher

- Added drag-and-drop tab reordering backed by the canonical persisted workspace order, without restarting PTYs or changing the active tab.
- Added a robot action beside the new-PowerShell `+` button that creates a normal shell tab and starts the bundled Codex-FE picker once.
- Added unit and isolated Electron coverage for renderer drag dispatch, persisted ordering, robot-button wiring, and picker command launch.

## 2026-09-09 - Transient Picker Tabs

- Replaced the platform-colored robot emoji with a monochrome SVG that uses the same orange token as tab `PS` markers.
- Added a distinct persisted `picker` tab kind that launches Codex-FE directly and removes itself when the picker exits.
- Excluded picker tabs from closed-tab history so selecting a session or quitting the picker does not leave a dead shell tab or a restorable transient entry.
- Preserved active picker tabs during whole-host shutdown so they can restart with the saved workspace like other currently open tabs.

## 2026-09-27 - Claude Code Support

- Added a unified Codex/Claude picker with provider-qualified identities across filtering, conversation search, favorites, selection, tab reuse, and restoration.
- Added Claude transcript indexing with complete-record incremental caching, explicit-name precedence, last-message timestamps, latest folder/model, and exclusion of sidechains, subagents, orphans, and metadata-only stubs.
- Added `--provider all|codex|claude` and `--claude-home`, honoring `CLAUDE_CONFIG_DIR` by default. Empty interactive lists still allow creating a first chat.
- Added blue Codex `CX` and orange Claude `CL` indicators in the picker and host tabs, with gray standalone PowerShell `PS` markers.
- Added Claude full-trust launches, deterministic new-chat UUIDs, transcript title/folder refresh, and provider-preserving closed-tab and host restart behavior.
- Migrated legacy UUID favorites and provider-less workspace tabs to Codex while retaining the existing shared host workspace location.
- Verified 16 Python tests, 21 Node tests, and isolated Electron/ConPTY integration covering mixed-provider launches, tab reuse, closed-tab recovery, colors, and host restart. Cached listing of 379 local sessions completed in approximately 0.63 seconds; no running user host was restarted.
