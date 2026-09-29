# Container SSH credentials

CCC prepares SSH credentials when creating, restarting, or reusing a local
container. A host-owned, mode-0700 SSH directory must work even when the `ccc`
user has a different UID. The host directory stays read-only and its content,
ownership and permissions remain unchanged.

Root reads the mounted directory into a private temporary archive. Extraction,
permission normalization and publication run as `ccc`, never as root. The
managed `/tmp/.ssh-copy` contains mode-0700 directories and mode-0600 files.
Source symlinks and special files are unsupported and fail preparation without
following their targets. A destination symlink is rejected without modifying
its target. Key contents and archive data must not appear in diagnostics.

Each successful refresh replaces the key snapshot: removed identities disappear
and repeated preparation does not create a nested `.ssh` directory. Existing
regular `known_hosts` entries learned inside the container are retained alongside
host entries. Concurrent preparations serialize publication. An ordinary
preparation failure preserves the previous copy and emits a warning that SSH
credentials could not be refreshed; the container remains available.

Git retains the existing `GIT_SSH_COMMAND`, including its RSA/Ed25519 identity
paths and `accept-new` host-key policy. This repair does not change SSH-agent
forwarding or add support for custom SSH config/identity paths. Author name and
email are separate from authentication. No GitHub key registration or container
recreation is necessary when usable host keys already exist.

Verify with lifecycle unit tests, actual archive/extraction regression tests,
and a disposable UID-mismatch fixture. For live diagnosis use `git ls-remote`
with an SSH remote: plain `ssh` does not use `GIT_SSH_COMMAND`. Live repair must
preserve the running container identity and start time and leave host keys
unchanged.
