---
type: REQ
status: active
created: 2026-09-25
source: user bug report (`ccc codex` on a Windows host failing with "Permission denied (os error 13)" while installing the app-server daemon), reproduced on a WSL2 drvfs mount
---

# Codex daemon packages live on a named volume

`ccc codex` must start on every supported host, including hosts where the
codex credential directory (`~/.ccc/codex`, mounted at `/home/ccc/.codex`) is
backed by a Windows filesystem.

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
5. The codex recovery wipe never deletes `packages`, because that is the
   shared volume other projects' containers are using. The prompt and the
   completion message say so ("except auth.json, config.toml and the shared
   daemon packages").
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
