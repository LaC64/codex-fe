# Codex-FE Host

Electron terminal host for Codex-FE. It owns PowerShell/ConPTY processes, visible tabs, and browser-style tab restoration.

## Run Directly

```powershell
.\start.cmd
```

Direct startup restores tabs from `~/.codex/codex-fe-tabs.json`. Normal use starts the host automatically after selecting a session in the Python Codex-FE picker.

Selecting a session that is already open focuses its existing tab. Use the `+` button in the tab bar to open a standalone PowerShell tab without starting Codex. Both Codex and PowerShell tabs remain in the saved workspace until their tab is closed.

When managed Codex exits but leaves the tab at its PowerShell prompt, selecting that session again resumes Codex inside the existing tab rather than creating a duplicate or doing nothing.

Press `Ctrl+Shift+T` to reopen the most recently closed tab. Repeated presses restore older tabs in reverse close order. The 50 most recently closed tabs are retained across host restarts.
