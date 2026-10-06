# CCC session exit cleanup

The host CCC process must remain responsive to SIGINT, SIGTERM and SIGHUP while
an interactive container command runs. It must await that command asynchronously
with inherited terminal input and output. Noninteractive commands retain their
existing execution and exit-status behavior.

On a handled termination signal, interrupt only the runtime client created by
this CCC invocation before the existing session cleanup handler can exit. Never
kill a daemon, unrelated process, or another project by name or age. Remove the
command's signal listeners after completion or launch failure. Input must have
one owner; this change must not add a competing terminal reader or replay a TUI.

After the last authorized session exits, stop only its captured container ID
under the existing lifecycle lock. Any foreign ownership claim, including an
unreadable or otherwise uncertain claim, continues to veto shared-container
shutdown. Do not infer dead ownership from container age.

Reconcile conclusively stale host-process claims under that lifecycle guard at
session reservation and before the shutdown veto. Missing owners and versioned
start-token mismatches authorize stale removal; live setup reservations and
indeterminate, unreadable or malformed claims remain protected. After attempted
removal, enumerate raw files again: a failed deletion still vetoes shutdown.

Diagnostic liveness observation, including `ccc doctor`, must not delete a dead
owner's receipt. It may omit stale owners from the live count, but consuming a
receipt before a guardian cleans it or a successor inherits its cleanup obligation
can leave the container running without an owner.

Production reservation and transfer of cleanup responsibility are one async
lifecycle-guarded transaction. Write the new reservation without pruning old
claims, capture its identity, positively inspect an existing managed container,
and establish guardian readiness and acknowledgment of that existing ID before
pruning dead predecessor claims. Inspection errors are not confirmed absence.
Failure before acknowledgment releases only the unchanged new reservation and
preserves predecessors. The project-family/worktree guard precedes the container
guard. Failures after an acknowledged existing-ID transfer retain the new receipt
and cleanup obligation, even if predecessor reconciliation partly completed. A
pending or rejected acquisition must retain receipt authorization (or
detach its failed context) through later CLI/signal cleanup so a replacement file
cannot be deleted by an unguarded fallback.

Production session setup must establish a host-owned lifetime channel with a
per-session guardian and await bounded readiness before starting the container.
Host process disappearance closes that channel. Without waiting for another CCC
invocation, the guardian removes only its captured unchanged claim under the
same lifecycle guard. Bind the claim's record and file identity; preserve a
same-path replacement or unreadable claim and its associated resources.

An acknowledged captured-container-ID handoff permits the guardian to reuse the
same last-owner cleanup workflow on owner disappearance. Before handoff, it must
not discover or stop a container by name. Normal successful cleanup releases the
guardian and all resources without replaying cleanup. Failed startup readiness
must abort visibly and reclaim only its own claim. Unexpected guardian loss must
surface and route through owned session failure cleanup.

Native stop must finish within a 30-second local subprocess budget. Only a clean
zero status counts as success. Spawn errors, signals, nonzero or absent statuses
must surface a bounded failure without raw runtime output or configuration
values. Failed stop must not finalize cleanup; a later call rechecks ownership
and can retry. Retain the own claim through device/container cleanup and remove
it only after successful stop (or after another owner vetoes stop). Non-ENOENT
claim removal errors remain failures. A timeout leaves the daemon-side outcome unknown.

For an ended host owner, release the captured unchanged claim before foreign
enumeration and device/container cleanup, inside the same lifecycle guard. A
daemon stop failure must not leave a dead-owner claim active. Failed own removal
still prevents effects, and unknown foreign ownership still vetoes shutdown.
The guardian must report bounded cleanup failure and exit nonzero; a pending IPC
send must not overwrite that failure status. Retryable living-owner cleanup
retains its different stop-before-removal ordering.

Verify with owned fake subprocesses: signal the parent while the interactive
child is ready and alive, observe prompt signal handling, and join all fixtures.
Cover native stop failures, successful retry, and a foreign claim appearing
before retry. Build and test the shipped host CLI as well as source modules.

Forced process termination cannot run the parent's JavaScript cleanup; the
separate guardian must cover host owner death. Real built-process fixtures must
force-kill the owner and prove automatic claim removal without subsequent CCC
queries, two-owner isolation, successor preservation and exact-ID final stop.
Windows console-close and actual Docker/Podman shutdown require native acceptance
after installing the updated host CCC. Portable fixtures do not prove these paths. A client
disconnect while a foreign owner retains the container does not authorize killing
that container or its shared Codex daemon.
