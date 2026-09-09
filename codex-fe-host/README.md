# Codex-FE Host

Electron terminal host for Codex-FE. It owns PowerShell/ConPTY processes, visible tabs, and browser-style tab restoration.

## Run Directly

```powershell
.\start.cmd
```

Direct startup restores tabs from `~/.codex/codex-fe-tabs.json`. Normal use starts the host automatically after selecting a session in the Python Codex-FE picker.

Selecting a session that is already open focuses its existing tab. Use the `+` button in the tab bar to open a standalone PowerShell tab without starting Codex. Both Codex and PowerShell tabs remain in the saved workspace until their tab is closed.

Drag tabs to persist a new order. The monochrome orange robot button beside `+` opens the Codex-FE picker in a temporary tab. The tab closes without entering closed-tab history when the picker exits, while the selected or already-open session remains active.

When managed Codex exits but leaves the tab at its PowerShell prompt, selecting that session again resumes Codex inside the existing tab rather than creating a duplicate or doing nothing.

Press `Ctrl+Shift+T` to reopen the most recently closed tab. Repeated presses restore older tabs in reverse close order. The 50 most recently closed tabs are retained across host restarts.

The orange `PS` tab marker becomes a Braille spinner while that tab's terminal is producing output, then returns to `PS` after the output becomes idle.

Tabs grow up to `520px` wide and wrap onto additional header rows instead of showing a horizontal scrollbar.

Terminal padding is applied to xterm itself so its fit calculation keeps the final PowerShell row visible as the tab header grows.

The host persists whether its window is maximized and restores that state the next time it starts.

New and resumed Codex sessions use full-trust mode and disable the alternate screen with `--dangerously-bypass-approvals-and-sandbox --no-alt-screen`.
