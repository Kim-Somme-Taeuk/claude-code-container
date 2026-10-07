# Bounded container exec readiness extraction

The brief retry policy now lives in
`src/application/container-exec-readiness.ts`, behind required synchronous
`ContainerExecReadinessPorts` in `src/ports/container-exec-readiness.ts`.
The contract requires `now(): number`,
`canExec(target: string, timeoutMs: number): boolean` and
`sleep(ms: number): undefined`. Uncalled compile consumers reject omitted or
noncallable capabilities, asynchronous observations, wrong clock/probe values,
and void, value or Promise sleep implementations. The native exec helper remains
structurally compatible. `run(target: string): boolean` requires a string target
and returns a synchronous boolean.

Factory construction checks now/canExec/sleep callability in that order without
executing a capability. Malformed capabilities throw `TypeError` with
`Container exec readiness requires a callable NAME port.`. Capability getter
exceptions preserve their original thrown values. Each run uses live port
lookups and their receiver, with its own deadline and no ambient clock,
default ports, timing configuration or generic retry machinery.

The literal retry arithmetic is preserved: `deadline = now() + 750`, at most
three attempts, a pre-probe remaining-budget read, and a probe timeout of
`Math.min(200, remaining)` when remaining is positive. A successful probe returns
true immediately, even if it finishes after the deadline, without another
clock observation. Every failed probe reads the clock to compute
`Math.min(75, deadline - now())`; this includes the final failed attempt.
Positive pauses run only after the first two failures. The third failure
retains its post-probe clock read and skips sleep. Exhaustion returns false.
Fractional budgets stay unrounded, zero/negative pauses are skipped, and forward
or backward wall-clock jumps retain existing behavior. Backward jumps cannot
extend the loop beyond three attempts. Clock, probe and sleep failures preserve
Error and non-Error identity and suppress later effects. Sleep results are
ignored without inspection or awaiting.

Docker remains the temporary native composition root until M13. Its private
retry helper allocates `new Int32Array(new SharedArrayBuffer(4))` before factory
construction and clock observations, binds late native `Date.now()` and
`Atomics.wait(sleeper, 0, 0, ms)` calls, and invokes the existing exec helper.
Allocation failures also escape unchanged. Native receivers, runtime choice,
exec argv, timeout handling, stdio and status behavior remain at this boundary.
Public signatures, exact target selection, lifecycle replacement guards,
caller decisions and the index lifecycle lock retain their existing authority.
Guarded running/restart and safe-defer paths use brief retry; unguarded
running/restart readiness retains its one default native probe.

Source verification anchors are the architecture
`container-exec-readiness-types.test.ts`,
`container-exec-readiness-core.test.ts` and
`container-exec-readiness-facade.test.ts` suites. Core checks use explicit fake
clock values; facade checks execute the actual public `startProjectContainer`
with real lifecycle composition, lifecycle policy and readiness application,
fencing native boundaries rather than mocking the retry itself.

Shared `scripts/test-workspace-packages.mjs` checks strict declarations,
type-only ports, the compiled Docker import/private binding and unchanged
public signatures. `verifyExecReadiness` executes decisive compiled policy
cases. The distinct `verifyCompiledPublicExecReadiness` fixture invokes actual
compiled public `startProjectContainer` for third-probe success and exhaustion
with denied replacement in both extracted npm and materialized install forms.
It fences filesystem/native commands, supplies fake paths and cached runtime
facts, and synchronizes builtin ESM exports. Import/export checks and compiled
application execution alone are not public-caller proof. Coordinator package
verification passed both forms. Independent code/documentation
review and fresh CLI QA against final source and artifacts remain required
acceptance gates.

## Known ceiling

Known ceiling: 750ms schedules retry attempts; it is not a guaranteed elapsed
completion bound or hard cancellation — upgrade when an approved native
protocol can bound or cancel the operation itself. Native probes may overrun
their budgets, and late success and wall-clock jumps preserve compatibility.

Known ceiling: portable fixtures and package checks cannot certify native
macOS/Windows, real Docker/Podman, rootless UID/SELinux or remote behavior —
upgrade when retained native acceptance gates run against actual source and
artifact hashes. The unavailable native PowerShell parser check remains SKIP.

M10k is a candidate slice covering brief exec retry policy. Native probes/host
facts, other preparation, setup/credentials, cache ownership, identity-fenced
claim release and reliable native outcomes remain M10 work. M13 composition
closure, M14 acceptance and the M00–M14 Goal remain outstanding; independently
blocked M02c attestation is unaffected.
