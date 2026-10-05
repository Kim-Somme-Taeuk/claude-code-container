# Host SSH credential copy

The host `.ssh` directory remains a read-only bind mount. Its private files may
be owned by a different UID from the container's `ccc` user. Startup and reuse
must refresh `/tmp/.ssh-copy` without changing host ownership or permissions.

Only archive creation reads the mounted source with noninteractive sudo.
Archive output is redirected by the unprivileged caller to a private temporary
file. Extraction, permission normalization and publication run as that caller;
keys belong to `ccc`, directories use 0700 and private files use 0600. Archives
are removed on normal success/failure. Failed reads invalidate stale copies and
emit only the existing generic warning, never key material. Source symlinks
are not dereferenced by archive creation or permission normalization.

A real Linux shell test reproduces an unreadable source owned by another UID
and verifies the copy and unchanged source permissions. This establishes the
permission-boundary fix; native macOS container-runtime verification remains
pending when a Mac is available.

## End-to-end source audit (2026-10-05)

| Boundary | Finding / disposition |
| --- | --- |
| Host discovery | Existing `.ssh` is detected; filesystem identity canonicalizes root symlinks and detects retargeting. Native mount UID presentation remains platform-dependent. |
| Mount proof | Generated 0600 challenge can be unreadable before copying. Retry only the exact SSH challenge path as container root; compare the same token and keep identity checks. Never read a key for proof. |
| Source read | Elevated tar read handles differing source UID; extraction remains caller-owned. Source permissions remain unchanged. |
| Publish | Replace copied completion-marker links rather than following them. Failed final publication removes stale backup instead of restoring a success marker for old credentials. |
| Reuse | New/start/reuse and accepted running-container update deferral all refresh credentials before syncing Git signing configuration. Existing container lifecycle locks serialize startup operations. |
| Failures | Shell regressions inject source-read, extraction, chmod and publication failures, asserting no stale completed copy or temporary archive/stage. |
| Git signing | Exact standard host key paths are rewritten only after a completed regular-file copy; other signing configurations remain unchanged. |
| Key symlinks | Links are preserved without dereferencing outside the mounted source. Host absolute links and external targets are not made portable automatically. |
| SSH configuration | Git explicitly selects copied RSA/Ed25519 keys; custom IdentityFile paths, Include files and direct `ssh` still need container-valid configuration. Copy success is not authentication proof. |
| Agent routing | Unresolved: Darwin assumes Docker Desktop's host-services socket even for other runtimes; native macOS Podman forwarding is not proven. |
| Agent permissions | Unresolved: existing chmod666 may fail across UIDs or broaden host socket permissions on native binds. A separate agent-transport change is required. |
| Agent replacement | Unresolved: pathname-only proof cannot detect a same-path replaced Unix socket; existing containers may retain an old bind. |
| Windows agent | Native OpenSSH named-pipe forwarding is not implemented by the Unix-socket mount path. |
| Authentication | Encrypted-key unlocking, hardware-backed keys, remote authorization and network failures require separate integration checks. |

These are source and automated-test audit results, not a claim that every SSH
failure or every host-runtime combination has been eliminated. No native Mac
was available for the reported historical failure.
