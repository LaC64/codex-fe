# Codex-FE Workstream History

## 2026-07-28 - Persistent Workspace Dashboard

- Replaced manual workspace restore as the normal workflow with a persistent Codex-FE dashboard in a named Windows Terminal window.
- Plain `codex-fe` now starts or focuses that dashboard and restores saved sessions automatically after the managed window is closed.
- Kept workspace state in `~/.codex/codex-fe-workspace.json`, archived the prior history-only workspace format during migration, and added explicit dashboard removal with `Alt+d`.
- Preserved `--restore` and `--restore-picker` as compatibility aliases for the dashboard launcher.
- Fixed an empty dashboard filter being passed as a bare `--name` argument by omitting the option when no filter is set.
