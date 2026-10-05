# Upstream integration: preserved CCC behavior

Base: upstream eb91ee5 (1.1.90). Prior fork: f154462, tagged
ccc-before-upstream-integration-20261005. Preserve upstream ancestry and current
package, daemon/resume, profile and container-session architecture.

## Upstream maintenance

Before beginning repository changes, fetch upstream and inspect changes since
this fork's integrated upstream ancestor. Integrate frequently in a separate
branch, retain a rollback tag, and port behavior with regression evidence.
Do not replay obsolete implementations when upstream already supplies the fix.

## Ownership and retained state

Supported Linux/WSL containers use the host effective UID and primary GID;
Podman keep-id and desktop mappings retain their explicit semantics. Runtime
identity must be checked before every running-container reuse/defer path.
Running work is never stopped automatically to change identity or mounts.
Mise and Codex package caches are scoped to runtime identity. Existing caches
are not recursively reowned while in use or deleted during migration.

Resolve the active profile and existing home layout before creating Codex or
Harness state. Preserve auth/config/session contents and avoid an empty new
profile shadowing existing state. A legacy retained-state transition requires
trusted previous-image UID/GID and exact bind-root identity; no guessed owners,
symlink traversal, unrelated owner changes or concurrent active users. Access
checks must cover the resolved default or named profile, not a hardcoded path.

Configuration access repair retains ownership, ordinary modes, user settings
and unrelated ACL permissions. Coordinate host/config writers across projects
using the stable legacy root lock for the default profile and locks keyed by
the resolved config for named profiles; host access restoration runs
inside the writer lock.
Reject unsafe targets rather than broadening access or resetting state.

## Startup, authentication and bridges

Keep upstream selected-tool-only setup, bounded probes, native Claude layout,
Codex daemon initialization and resume repair. Restore missing npm wrappers
from verified installed cache executables before reinstalling packages. Probe errors
fail without reinstalling over existing state. Prepare the selected OpenCode
data root before its cached executable probe.
OpenCode access preparation is limited to its mounted data root and preserves
unrelated permissions. Repeated ordinary launch failures never erase sessions.

SSH preparation retains upstream signing-key completion markers and its
failure invalidation of stale credentials. Preserve learned regular known_hosts
entries only when private provenance proves the authoritative host file is
unchanged. Host key rotation or deletion must not restore superseded trust,
including hashed or wildcard entries. Never chmod the forwarded host
agent socket. Existing valid host keys remain usable across UID mismatch.

### Known ceiling

The first refresh without valid provenance, or any change to authoritative
known_hosts bytes or presence, resets container-learned trust. Users must verify
those additional hosts again. This avoids guessing whether hashed or wildcard
entries conflict with changed authority. An SSH entry larger than 16 MiB fails
snapshot preparation; the incomplete snapshot is invalidated.

Clipboard port-file publication preserves a file bind mount's inode across
normal stop/restart. Serialize legacy server retirement and replacement;
authenticate live health rather than trusting a saved token. Preserve upstream
clipboard text/image support and layout-aware paths. Unreadable mounted token
files fall back to configured environment values. Probe proxy LISTEN state
without requiring ss or opening a connection to the proxy itself.

Remember only explicit mise generation declines per project, including declines
saved by the prior layout. Existing project tool configuration still applies.
Remote cache identity comes from the remote image, never the local host UID.

## Harness boundary

CCC bootstrap is preserved only as installation/readiness integration: use
container-local paths, preserve disabled/custom settings and existing payloads,
including payloads whose registration is missing,
and diagnose bootstrap failure without making Codex unusable. Harness engine,
watcher and receipt fixes remain in the separately installed Harness repository.

## Local change classification

| Local changes | Integration decision |
| --- | --- |
| aac2f3d/ad5b11d/fc44313, identity and safe failure | Adapt to upstream lifecycle; preserve socket modes |
| 0f251bf/9d0312c/abf99fa, retained Codex ownership | Adapt to resolved profiles and package volume |
| 5707650/c5cc6c0, ACL/config/selected tool | Port ACL/config protection; reuse upstream selected-tool and daemon logic |
| 0eafcf5..3166cae, clipboard/wrappers/proxy | Adapt missing behavior to upstream home layout/native tool installation |
| abdb89a, OpenCode ACL | Port narrow root access preparation |
| a2a6b60, SSH snapshots | Reuse upstream cross-UID/signing implementation, retain known_hosts and socket fixes |
| e2108ed/39fccc9/e16a502, mise declines | Preserve per-project preference and regressions |
| 1a4f8ee, remote cache | Adapt remote image identity selection |
| 53b4b03, owner path | Already implemented by upstream package-based canonical helper |
| cb2bd7f/c9a9c3e/933f96a/5c69689, tests | Check equivalent isolated/bounded/asynchronous upstream tests; retain missing assertions |
| 86f9e45/f77e009, Harness integration | Preserve readiness semantics, use current Harness runtime separately |
| b7f3f5b/9ffcf15/f9fecc1/8b281dc | Retain intent in adapted tests and ownership documentation |
| 90bd161, original DeviceLab snapshot | Use newer upstream package implementation |
| f154462, orphan cleanup | Remove still-unreferenced helper/test and obsolete metadata |

## Verification and deployment

Exercise UID1000 and another UID/GID through disposable bind-mounted projects;
verify both sides can write after recreate. Test prior-owner state, refusal while
active, named/default/legacy profile paths, preserved content hashes, package
volume access, ACL boundaries, SSH key/socket modes, clipboard restart mounts,
mise preferences and wrapper reuse. Run full build, portable upstream suites,
package assembly checks and independent code/security/CLI QA. Do not claim
unavailable Windows/HyperV physical execution from Linux-only tests.

Install only after validation from a surviving checkout, verify actual CLI and
image identities plus Codex/Harness startup paths. Retain original code tag;
code rollback alone does not undo home-layout migration. Preserve original
state and record actual resolved paths. Push the integration branch and dispose
of its temporary worktree after the surviving checkout owns the result.
