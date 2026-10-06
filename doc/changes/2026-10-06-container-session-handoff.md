# Container session handoff extraction

The shared final container-to-session policy now lives in
`src/application/container-session-handoff.ts`, behind required synchronous
ports in `src/ports/container-session-handoff.ts`. The two source assertion
ports return `undefined`; identity lookup returns the reused
`ExistingContainerIdentity | null` synchronously. Factory construction validates
all three callable capabilities in order without executing them. Missing or
malformed capabilities throw `TypeError`; capability getter failures preserve
their original thrown values.

Handoff keeps project assertions before filesystem assertions. Only a truthy
readiness callback triggers the final pinned-ID lookup. The literal running/ID
short circuit suppresses ID reads for stopped identity and refuses missing,
stopped or successor containers with the existing exact message:
`Container identity changed before session handoff; refusing to join.`
Absent/falsy callbacks still run source checks and skip final identity inspection.

Readiness remains a public void callback: legacy value and Promise returns are
accepted and ignored without observation or awaiting. It receives the pinned ID
through a bare call with an undefined receiver, followed by the public container
name return. Malformed truthy callbacks fail after source checks and valid
identity. Assertion, identity lookup/getter and callback errors, including
non-Error values, escape unchanged. Late failure preserves the existing or
verified fresh container without new stop/remove compensation.

Docker remains a temporary composition root until M13. The existing finish
closure constructs the factory late, binds two assertion wrappers and
`getContainerIdentity`, and runs the application. The existing void finish
wrapper and fresh direct finish call retain their positions. The cutover is one
import plus the finish body; native helpers, lock/preparation order, runtime
choice, public signatures and cleanup retain their behavior.

Coordinator source verification passed for the core/types, real public facade
paths and prescribed regressions. Shared distribution smoke now checks shipped
declarations, the compiled Docker import, type-only ports and actual compiled
application behavior in extracted npm packages and materialized installs.
Coordinator distribution execution passed for both forms. Independent reviews
and fresh CLI QA are required acceptance gates; portable implementation checks
do not certify native behavior.

## Known ceiling

Known ceiling: final identity observation and readiness execution are not
atomic — upgrade when an approved protocol supplies stronger runtime authority
across that interval. This extraction adds no retry or atomicity guarantee.

Known ceiling: portable fixtures cannot certify native macOS/Windows, real
Docker/Podman, rootless UID/SELinux or remote handoff behavior — upgrade when
retained native acceptance gates run against actual source and artifact hashes.
The unavailable native PowerShell parser check remains SKIP.

M10i is a candidate slice. Other preparation, readiness/host facts,
setup/credentials, cache ownership, identity-fenced claim release and reliable
native outcomes remain M10 work. M13 composition closure, M14 acceptance and the
M00–M14 Goal remain outstanding; independently blocked M02c attestation is
unaffected.
