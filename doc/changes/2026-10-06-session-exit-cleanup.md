# Responsive session exit and checked container shutdown

Interactive container execution now awaits an inherited-stdio asynchronous
runtime client. CCC's existing SIGINT/SIGTERM/SIGHUP cleanup callbacks can run
while a long-lived terminal command is active. Prepended listeners interrupt
only the runtime client created by this invocation before the existing cleanup
callback exits; ordinary completion removes the listeners. Noninteractive
execution retains its synchronous status behavior.

The native session stop adapter retains runtime-before-lazy-ID evaluation and
targets only the captured container ID. Its local subprocess wait is bounded to
30 seconds. Errors, signals and nonzero or absent statuses now prevent cleanup
finalization and report a bounded failure without raw runtime output. A retry
still rechecks foreign ownership, and a newly appearing foreign claim vetoes
shared-container shutdown.

Private owned-process fixtures demonstrate parent-directed INT/TERM/HUP handling
before the child finishes normally and confirm owned-client retirement. The
combined portable build, lint, 38 regression files with 2,400 tests and both
package distribution forms passed. Independent review and fresh QA are pending.

## Known ceiling

Forced termination cannot run JavaScript cleanup. Actual Windows terminal-close
and Docker/Podman shutdown need native acceptance after rebuilding and installing
the host CLI; the already running old host/daemon is not patched by source edits.
Raw foreign ownership claims remain conservative vetoes. Retiring a local client
does not prove that a daemon-side exec has ended when a foreign owner retains the
container. A stop timeout leaves the daemon-side outcome unknown. Existing
best-effort own-claim removal does not become durable transactional recovery.
