# Codex-FE Host

Electron terminal host for Codex-FE. It owns PowerShell/ConPTY processes, visible tabs, and browser-style tab restoration.

## Run Directly

```powershell
.\start.cmd
```

Direct startup restores tabs from `~/.codex/codex-fe-tabs.json`. Normal use starts the host automatically after selecting a session in the Python Codex-FE picker.

Selecting a session that is already open focuses its existing tab. Session identity includes its provider (`codex` or `claude`) and session ID. Use `+` for standalone PowerShell. Codex, Claude, and PowerShell tabs remain in the saved workspace until closed.

Drag tabs to persist a new order. The monochrome orange robot button beside `+` opens the Codex-FE picker in a temporary tab. The tab closes without entering closed-tab history when the picker exits, while the selected or already-open session remains active.

When an agent exits to its PowerShell prompt, selecting that session again resumes the same provider inside the existing tab.

Press `Ctrl+Shift+T` to reopen the most recently closed tab. Repeated presses restore older tabs in reverse close order. The 50 most recently closed tabs are retained across host restarts.

Blue `CX` marks Codex tabs, orange `CL` marks Claude tabs, and gray `PS` marks standalone PowerShell tabs. The marker becomes a Braille spinner while the terminal produces output, retaining its color.

Tabs grow up to `520px` wide and wrap onto additional header rows instead of showing a horizontal scrollbar.

Terminal padding is applied to xterm itself so its fit calculation keeps the final PowerShell row visible as the tab header grows.

The host persists whether its window is maximized and restores that state the next time it starts.

New and resumed Codex sessions use full-trust mode and disable the alternate screen with `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`.

Claude sessions use `--dangerously-skip-permissions`, resume with `--resume <uuid>`, and start new chats with an assigned `--session-id <uuid>`. Each Claude tab saves its config home, transcript path, and provider with the shared workspace. The host refreshes title, model, and last-used folder from that transcript. Explicit names take precedence over AI titles.

Existing workspace tabs without a provider normalize to Codex. Both open tabs and closed-tab history retain their provider across restarts. Executable overrides are `CODEX_FE_CODEX_EXE` and `CODEX_FE_CLAUDE_EXE`; Claude otherwise resolves from `PATH`.
