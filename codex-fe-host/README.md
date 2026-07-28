# Codex-FE Host

Electron terminal host for Codex-FE. It owns PowerShell/ConPTY processes, visible tabs, and browser-style tab restoration.

## Run Directly

```powershell
.\start.cmd
```

Direct startup restores tabs from `~/.codex/codex-fe-tabs.json`. Normal use starts the host automatically after selecting a session in the Python Codex-FE picker.

Selecting a session that is already open focuses its existing tab. Use the `+` button in the tab bar to open a standalone PowerShell tab without starting Codex. Both Codex and PowerShell tabs remain in the saved workspace until their tab is closed.
