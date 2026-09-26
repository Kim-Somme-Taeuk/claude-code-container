# doc/common — note index
updated: 2026-04-17

## Notes

- [OBS: Workspace Layout](OBS__repo__workspace-layout.md) — detected project structure, languages, tooling (refreshed for container-runtime module + Containerfile)
- [REQ: Primary Goals](REQ__project__primary-goals.md) — project goals (runtime-agnostic execution added 2026-04-17)
- [INF: Initial Assumptions](INF__arch__initial-assumptions.md) — inferred architecture assumptions (Podman runtime abstraction)
- [REQ: claude update inside a container](REQ__claude-update-inside-container.md) — the launcher must stay in the shape the native updater manages, and what the shared volume forces
- [REQ: container init and socket access](REQ__container-init-and-socket-access.md) — --init reaps orphans; the default user joins the socket group; Testcontainers/Ryuk and volume cleanup guidance
- [REQ: codex daemon packages volume](REQ__codex-daemon-packages-volume.md) — ~/.codex/packages lives on the shared ccc-codex-packages volume because Windows-backed binds reject codex's post-exec rename
- [PLAN: Remote Terminal IDE Architecture](PLAN__remote-terminal-ide-architecture.md) — proposed long-term local/remote sync, Git authority, daemon, persistent workspace, and container/VM design
- [GUIDE: an errno's path is not the recorded path](GUIDE__errno-path-is-not-the-recorded-path.md) — only realpathSync truncates; carry a recorded path from the site that read it; what an operator message must escape, and what a skip stops protecting
