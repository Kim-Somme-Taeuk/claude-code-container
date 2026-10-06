# Container runtime refusal policy extraction

The refusal sequence inside `ensureDockerRunning` now lives in
`src/application/container-runtime-readiness.ts`, behind the required ports in
`src/ports/container-runtime-readiness.ts`. The observations return a boolean
and `{ runtime: RuntimeName; flavor: string }` synchronously;
`reportError(message: () => string)` and exit return `undefined`. Message
suppliers return strings synchronously; eager strings and async/void suppliers
are rejected by the type contract. The pure domain `RuntimeName` is imported
as a type. Native `RuntimeInfo` and its flavor union stay in the native facade, whose existing
facts satisfy the port structurally.

Construction validates `isRunning`, `runtimeInfo`, `reportError` and
`exitFailure` as callable, in order, without invoking them. Missing or malformed
ports throw `TypeError` with the exact
`Container runtime readiness requires a callable NAME port.` diagnostic;
capability getter exceptions preserve their original thrown values.

`run(): undefined` keeps the original running guard. A ready runtime skips the
additional explicit info-port observation, both refusal reports and exit.
Failure looks up info once and supplies the first diagnostic lazily. The
reporter selects its native callee and receiver before evaluating the supplier
exactly once synchronously. Thus `console.error` property access precedes
reading runtime for `Error: ${info.runtime} is not running.`. After reporting,
the application reads runtime again for branching.
Flavor is read once for Docker or a Podman machine and twice for other Podman
branches. There is no snapshot, normalization or fact validation, so changing
getters and report-time mutations retain their original effects.

All five recovery hints retain their exact text: Docker Desktop, the Docker
service, a Podman machine, rootless Podman and the Podman service. Unknown,
arbitrary and cross-runtime flavor strings retain the existing branch behavior.
The second report precedes failure exit. Observation, fact getter, reporting
and exit failures preserve Error and non-Error identity and stop later effects.
Promise or thenable effect results are ignored without inspection, awaiting or
returning; the application remains strictly synchronous.

Docker remains the temporary composition root until M13. Its public wrapper
keeps `ensureDockerRunning(): void`, constructs the factory per call and invokes
the existing observations. Its reporting and exit wrappers look up
`console.error` and `process.exit` late and preserve their native receivers.
The direct `console.error(message())` call selects the reporter before
rendering the message once without retaining the supplier; exit uses code 1.
The cutover is one import and that function body. Existing
index, clean and lifecycle callers, locks and native helpers keep their behavior.

The native `isDockerRunning` probe remains unchanged: exact runtime `info`
argv, UTF-8 encoding, pipe stdio, status-0 readiness and DEBUG reporting of
trimmed nonempty stderr before refusal. `runtimeCli` may read cached facts as
part of that probe. Detection, selection and cache ownership stay native.
Recovery commands are printed guidance; the policy executes no service startup.

Verification anchors include strict architecture type contracts, core policy
tests and real Docker/application facade tests with mocked native boundaries.
Shared distribution smoke checks emitted declarations, type-only ports and the
compiled Docker import, then executes the actual compiled policy and facade in
both extracted npm packages and materialized installs. Combined runtime getter
and reporter accessor regressions preserve callee selection before first
interpolation, including mutations and thrown accessor values. Cached fake
facts and fenced native calls prevent real discovery or service execution.
Independent code/documentation review and fresh CLI QA against final source and artifacts
remain required acceptance gates; portable checks do not certify native behavior.

## Known ceiling

Known ceiling: a readiness observation does not guarantee readiness for later
operations — upgrade when an approved runtime protocol supplies authority
across that interval. This extraction adds no atomicity guarantee or retry.

Known ceiling: portable fixtures cannot certify native macOS/Windows, real
Docker/Podman, rootless UID/SELinux or remote behavior — upgrade when retained
native acceptance gates execute against actual source and artifact hashes.
The unavailable native PowerShell parser check remains SKIP.

M10j is a candidate slice covering refusal policy. Native readiness probes and
host facts, other preparation, setup/credentials, cache ownership,
identity-fenced claim release and reliable native outcomes remain M10 work.
M13 composition closure, M14 acceptance and the M00–M14 Goal remain outstanding;
independently blocked M02c attestation is unaffected.
