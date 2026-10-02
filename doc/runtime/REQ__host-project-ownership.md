# Host project ownership

CCC must preserve ordinary host access to files created by its project user.
On native rootful Linux, including WSL Linux project directories, `ccc` runs
with the invoking user's effective UID and primary GID. The named account and
HOME remain `ccc` and `/home/ccc`; sudo and supplementary groups remain usable.
Rootless Podman keeps its explicit host-user-to-container-1000 mapping.
Desktop filesystem sharing uses the default 1000 identity. Rootless Docker
cannot use a native host UID directly; reject that unsupported mapping with
an actionable error. Reject root or invalid native host identities.

Default images create ccc explicitly as 1000:1000. Only the known Ubuntu
placeholder account may be removed to free that UID. Runtime customization
uses cached derived images keyed by immutable base image identity, target
UID/GID and contract version. Reconcile image accounts and image-file ownership
only inside an image build without host mounts, without following symlinks or
reowning unrelated files. Retained lab volumes have a separate, bounded migration
described below.
Verify the named user, primary group, HOME and final image user before reuse.
Concurrent builds must serialize and failed builds must not publish valid caches.
Validation containers use the same applicable runtime mapping and cgroup options
as project containers. Image-download failure unwinds startup and session locks
so retrying after recovery does not require manually removing a lock.

Both image upgrade and mount-contract recreation must refuse to replace a
running container whose identity contract differs. Explain that the user must
finish the work and stop the container before retrying. Refusal must preserve
the existing container and remove only startup state owned by the failed new
session. Stopped legacy containers can transition without deleting projects,
credentials or prior cache volumes. Subsequent starts reuse the resolved image
instead of repeatedly comparing a derived image with its base.

For an already running container with the correct identity and mounts, an
image-only update is deferred: the command continues in the existing container
and prints instructions to stop it after its work finishes. Mount-contract drift
rejects startup while preserving the running container. Failed command execution
in a running or just-restarted container reports a diagnostic and requires
explicit inspection/stopping; it does not automatically kill or recreate it.

Mise cache volumes are scoped to the UID/GID and mapping contract. Existing
cache volumes remain intact. Any retained per-container writable state must
become usable by the replacement identity without changing live state or host
credential ownership. Diagnostics must inspect the same cache used by startup.
Forwarded SSH agent sockets keep their host permissions; startup must never
broaden a socket's mode to make the agent accessible to other host users.

Lab-volume migration runs only while that exact named volume has no running
container users. Establish its previous ccc UID/GID from the old container's
image before removal; translate only those owners, without following symlinks,
in a helper that mounts no host directories or credentials. An in-use volume,
unknown previous owner, or mismatched detached-volume owner rejects startup and
retains the data. Do not guess an old owner from the volume's root directory.
For recovery, finish the volume's running work, confirm the previous and target
numeric owners and the exact named volume, then repair only verified old-owned
entries in that isolated volume before retrying. Do not use a project-wide or
host-wide ownership command to repair a named volume.

## Existing projects

Changing the runtime identity prevents recurrence; it does not automatically
change ownership of existing host files. Finish active container work before
repairing a project. Verify host IDs with `id` and project ownership with
`ls -ldn`. For the confirmed old owner 1001:1001, a bounded repair is:

```bash
sudo chown -hR --from=1001:1001 "$(id -u):$(id -g)" ~/projects/project-txt
```

Use the actual old owner and project path. Do not recursively change unrelated
owners or credential directories. Stop the old project container after its
work finishes, then start it with the updated CCC. A live legacy container
continues to use its original identity until that transition.

## Verification

Use disposable bind-mounted projects to prove both host and container can
create and edit files, and inspect numeric ownership for UID1000 and a
non1000 user with a different primary GID. Check HOME, named-user commands,
sudo, mise writes, preserved credential sentinels, concurrent image builds,
cache reuse, and failure cleanup. Lifecycle tests must prove that neither
image-upgrade nor mount-contract drift stops a running legacy container.
Also verify that a compatible running container defers an image-only update,
that mount drift and command-execution failures preserve running work, and that
lab-volume migration failures retain data and provide a repair diagnostic.
