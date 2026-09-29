---
type: REQ
status: active
created: 2026-09-25
source: user bug report (`ccc codex` on a Windows host failing with "Permission denied (os error 13)" while installing the app-server daemon), reproduced on a WSL2 drvfs mount
---

# Codex daemon packages live on a named volume

`ccc codex` must start on every supported host, including hosts where the
codex credential directory (`~/.ccc/profiles/<profile>/codex`, formerly
`~/.ccc/codex`, mounted at `/home/ccc/.codex`) is backed by a Windows filesystem.

## Intent

Codex 0.157+ installs a background app-server daemon under
`$CODEX_HOME/packages/app-server-daemon`. It copies the release into
`releases/.staging.XXXX`, executes `bin/codex --version` from that staging
directory, and immediately renames the directory into place. On a Windows-backed
bind mount (Docker Desktop / WSL2 drvfs 9p) a directory cannot be renamed for
about a second after a binary inside it ran, so the rename returns `EACCES` and
codex fails every launch with `Error: Permission denied (os error 13)`. Codex
does not retry. Wiping `~/.codex` cannot help because the next install repeats
the same rename.

The packages are Linux binaries for the container, so they have no reason to be
on the host. ccc keeps them on a Docker named volume instead, the same way it
keeps the mise cache on `ccc-mise-cache`.

## Observable behaviors

1. Every ccc container mounts the named volume `ccc-codex-packages` at
   `/home/ccc/.codex/packages`. The volume is shared by all ccc containers on
   the host. codex serializes concurrent installs itself: strace of codex
   0.157 shows `flock(install.lock, LOCK_EX|LOCK_NB)` held for the whole
   install, and containers sharing the volume share that inode.
2. Everything else under `/home/ccc/.codex` (`auth.json`, `config.toml`,
   sessions, history) stays on the host bind mount, unchanged.
3. The ccc image contains `/home/ccc/.codex/packages` owned by `ccc`, so Docker
   initializes a new or empty volume as `ccc:ccc` and codex can write to it.
   An empty volume first created root-owned by an older image is initialized
   the same way the first time a container from the new image mounts it.
4. Before creating a container, ccc creates `<codex host dir>/packages` itself,
   so the bind-side mount point is owned by the user and not by the Docker
   daemon (root) on Linux rootful Docker.
5. Codex launch failures never offer or perform a state wipe. They also never
   trigger an automatic CLI update or blindly replay a failed command. For
   supported interactive launches (including `resume` and `fork`), a bounded
   check may invoke the installed CLI's bounded `app-server daemon start`
   when the daemon executable is positively confirmed missing. The original
   command, session arguments and environment are preserved. If start itself
   reports the exact missing managed executable error and installed root help
   explicitly supports `--no-daemon`, ccc adds that flag for this launch and
   reports the fallback. Daemon preparation does not replace shared packages or
   replay a TUI. Explicit remote/no-daemon invocations and noninteractive commands
   skip daemon preparation. Local resume recovery is described below. Uncertain probes leave the
   original invocation unchanged. Other initialization failures stop before the TUI
   while retaining normal cleanup. ccc never force-updates packages, restarts
   an existing daemon or deletes history as recovery. Supported configuration
   overrides are forwarded as arguments; unsupported profile selection must
   not silently start a differently configured daemon.
6. `ccc clean --volumes` removes `ccc-codex-packages` along with the other
   `ccc-` volumes.

## Rollout

- The volume is an additive required mount. A **stopped** existing container is
  recreated once on its next start. A **running** container keeps its old
  layout until it stops; run `ccc stop` and start again to pick it up.
- A container created by this version has a mount that older ccc binaries do not
  expect; an older binary treats it as a mount mismatch. The rollout is
  forward-only.
- If the image cannot be updated (pull failure keeps the old image), the volume
  may be created root-owned and codex still fails until the image updates.
  Anything already inside the host's old `~/.ccc/codex/packages` is hidden by
  the volume and can be deleted.

## Known ceiling

- Known ceiling: when ccc itself runs inside a ccc container (docker-outside-of-docker,
  `container=docker`), behavior 4 cannot pre-create the real host mount point,
  because the credential path it sees is the container path. On a Linux rootful
  Docker host the daemon then creates `<codex host dir>/packages` as an empty
  root-owned directory. codex is unaffected: the volume's own ownership comes
  from the image (behavior 3), not from the mount point.
- Known ceiling: `ccc doctor` does not report the `ccc-codex-packages` volume.

## Verification cues

- `docker inspect <container>` lists a `volume` mount named
  `ccc-codex-packages` with destination `/home/ccc/.codex/packages`.
- On a WSL2/Windows host, `ccc codex` no longer prints
  `Error: Permission denied (os error 13)` after "Installing daemon".
- `docker run --rm -v ccc-codex-packages:/v ccc ls /v/app-server-daemon`
  shows `releases/` and `current` after a codex launch.

- With the daemon executable absent, supported interactive Codex launches
  initialize the daemon before running the original command, retaining
  `resume`/`fork` session arguments and history.
- An unrelated Codex failure exits once, without npm updates, automatic replay,
  or a state deletion question.

- An incomplete package (broken current link or missing executable inside current)
  must not trap resume in a repeated daemon-start failure. The supported local
  no-daemon fallback preserves history and executes the user command once. It
  does not certify cross-version rollout compatibility; report any independent
  resume protocol failure instead of deleting state or retrying indefinitely.

## Automatic recovery for `list_turns` resume failures

`doctor` and `migrate-rollouts` are administrative Codex commands. CCC forwards
their arguments without adding chat permission flags, clipboard images or daemon
initialization. The user does not need an administrative recovery command for
the specific local resume failure below.

Codex 0.158.0 can report `list_turns is not supported yet (code -32601)` when
a paginated rollout has a stale `legacy` history mode in its SQLite index.
This was reproduced with synthetic history; it is not proof of corruption in
a user's conversation. For an eligible interactive local resume, CCC recognizes
only the exact terminal bootstrap error and non-interrupted failure exit. It
validates the failed rollout path under the effective Codex home's session tree
and its UUID, invokes the native migration for that session only, then retries
resume once for the same UUID. A short recovery notice replaces manual steps.

Terminal input, output, dimensions and signal behavior remain interactive. No
terminal transcript is saved. Captured output and migration responses are bounded.
Migration must report success for the exact UUID before retry. It can report
`already_paginated` while repairing stale index metadata. Native migration can
transform a legacy rollout; CCC never edits SQLite or deletes state itself.

If that migration reports the exact missing-SQLite-metadata error for the same
session, CCC may start one bounded native stdio app-server. It validates the
server's Codex home before requesting `thread/read` for that UUID with
`includeTurns:false`. The returned UUID and canonical rollout path must match
the failed session. This native read can reconstruct its missing metadata.
After a clean server exit, CCC may run the scoped migration once more before
the original single resume retry. Unsupported tooling, protocol errors, identity
mismatches and interruption stop recovery. RPC bodies and conversation previews
are never printed as diagnostics; existing history is not deleted or rewritten
by CCC.

Unrelated errors, cancellation, unknown options, explicit prompts/images, remote
sessions and unsupported configuration combinations never trigger recovery.
Unsupported native tooling or failed/locked migration preserves the failure and
history. CCC never broadens the repair, repeats a prompt or enters a retry loop.
The user's host recovery is confirmed only after their resume succeeds.

Failures use one fixed, short explanation and a stage identifier: `migration`,
`migration-after-metadata`, or metadata `support`, `home`, `initialize`, `read`,
and `close` (prefixed with `metadata-`). The stages distinguish a first migration
failure from one after metadata restoration, without replaying raw migration or
RPC diagnostics. Successful output and recovery bounds remain unchanged. These
diagnostics improve identification of the failure; they do not establish the
cause of the reported Mac failure or confirm that it has been repaired.

Recovery diagnostics, process handling and orchestration are ordinary strict
TypeScript modules with direct tests. The build bundles these modules for the
existing container launch transport; runtime behavior must not live in a
handwritten JavaScript string. Package verification exercises that generated
bundle without a source checkout. If the bundle is unavailable, CCC reports a
rebuild/reinstall diagnostic and runs the original command without recovery.
