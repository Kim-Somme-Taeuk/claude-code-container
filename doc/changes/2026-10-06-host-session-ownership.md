# Tie session cleanup to the host process lifetime

CCC now reconciles conclusively dead host claims after guarded acquisition and
before the final shutdown veto. Acquisition reserves without pruning predecessors,
positively inspects the existing managed container, and awaits guardian READY and
existing-ID acknowledgement before reconciling predecessor claims. An inspection
failure is not evidence of absence. Unknown, unreadable, live and undeletable foreign
claims remain protective. A hidden per-session Node guardian establishes an
acknowledged ownership channel before container startup; host disappearance
releases its unchanged captured claim without another CCC invocation. The
guardian reuses guarded cleanup and stops only an acknowledged captured container
ID when no foreign claims remain. Identical-content replacement files are
protected by native file identity. Active or pending ownership cannot be silently
overwritten, duplicated or cleared without cleanup.

`ccc doctor` observes liveness without deleting receipts, so diagnostic queries
cannot cancel a dead owner's pending container cleanup.

Living-owner stop failures retain the claim for a guarded retry. Ended-owner
cleanup releases its claim first, independently of daemon stop success, and
reports cleanup failure with a nonzero guardian exit. Ready/update/release
acknowledgements are bounded; the guardian adopts an ID only after its native ACK
write succeeds, and disconnect waits for pending ACK delivery. Failed acquisition
preserves receipt authorization against same-path replacements; before ID transfer
its rollback removes only its unchanged reservation. After transfer, failures retain
the captured cleanup obligation. Buffered replies after synchronous setup are
handled before a timeout can revoke ownership. Normal cleanup disposes the
guardian without repeating device/container effects.

Implementation validation after review corrections: full private Linux build passed;
eleven targeted suites passed 472 tests, including 15 real emitted owner/guardian subprocess cases. Tests
force-kill the owner without querying sessions afterward, exercise two-owner and
profile/project isolation, normal cleanup, same-path successors, failed exact-ID
stop, nonzero guardian exit, monitor loss and setup blocking beyond five seconds.
These tests include predecessor responsibility transfer, pre-ACK failure with a
diagnostic observation, pending-READY successor preservation through fallback
cleanup, asynchronous failed ACK delivery, and monitor loss immediately after ACK
or during guard release. Independent review and fresh QA remain required before
official completion.

## Known ceiling

Native Windows console-close and actual Docker/Podman shutdown still require
native acceptance. Portable process fixtures use owned fake runtimes and do not
prove those paths. A stopped container alone does not prove a live host setup
reservation is stale; uncertain legacy claims remain protected.
