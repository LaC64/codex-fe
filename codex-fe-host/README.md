# Codex-FE Host

Electron terminal host for Codex-FE. It owns PowerShell/ConPTY processes, visible tabs, and browser-style tab restoration.

## Run Directly

```powershell
.\start.cmd
```

Direct startup restores tabs from `~/.codex/codex-fe-tabs.json`. Normal use starts the host automatically after selecting a session in the Python Codex-FE picker.
