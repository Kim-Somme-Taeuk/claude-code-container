# Codex config preparation extraction

## Codex config preparation policy (M10m candidate)

`createCodexConfigPreparation` in `src/application/codex-config-preparation.ts`
owns the existing access-check, repair and finalization decisions.
`CodexConfigPreparationPorts` requires synchronous `probe(target)`,
`repair(target)` and `finalize(target)` observations with a required
`status: number | null` and optional `error: unknown`. Native spawn results fit
this contract without projection or cloning. The application imports only its
port type; it has no native dependencies or ambient defaults. Construction
checks probe, repair and finalize callability in order without effects, with
`Codex config preparation requires a callable NAME port.` TypeError diagnostics.
Port getter failures retain their original thrown value.

`run(target): undefined` preserves the literal branch expressions and repeated
status/error reads. Probe status zero returns before reading error. Otherwise,
error code ETIMEDOUT or status 124/137 yields `Codex config access probe timed out`;
truthy error or a disallowed status yields `Codex config access probe failed`.
A clean status one proceeds to repair. Repair and finalization classify the same
timeout conditions as `Codex config repair timed out`; truthy error or nonzero
status yields `Codex config repair failed`. Clean repair proceeds to finalization;
clean finalization returns undefined. The erased error type assertion leaves
optional-chain property access unchanged for opaque and primitive errors.
Dispatch, status/error/code getters and capability lookup exceptions propagate
unchanged, and no later stage runs after a failure. Other result fields remain
unobserved. There are no new retries, catches, rollback or persistent state.
Successful ownership repair followed by failed finalization remains visible as
partial failure; the application does not restore ownership or replay mutation.

Docker retains one private stateless application instance and its public
`prepareCodexConfigForContainer(containerName): void` signature. Native bindings
resolve the runtime independently when each effect runs. The existing fixed
shell bodies, quoting helper, target argv, ignored stdio and 15-second outer
limits stay in Docker. Each shell command retains its 10-second inner timeout
and 2-second kill grace. These are existing per-command limits, not an end-to-end
completion guarantee. Root repair changes entry ownership with `chown -h` only;
probe and final identity/access/permission proof run as the unprivileged
container user. The existing index caller, pinned target and setup lock remain
unchanged. Docker is temporary native composition until M13.

Verification anchors are the three architecture `codex-config-preparation`
core/type/facade suites and the shared workspace package verifier. Core tests
cover branch decisions, strict synchronous types, repeated and throwing getters,
opaque errors, live receivers and stateless calls. Facade tests import the
actual Docker/application/runtime modules and fence only native effects,
asserting exact commands and authority. The shared package verifier checks
compiled policy and actual public facade execution in both extracted npm and
materialized installation payloads, plus emitted declarations. Import/export
checks alone do not prove the public caller. Independent code/security/docs
review and fresh QA remain required acceptance gates.

Known ceiling: portable observations and inert command fixtures do not establish
real Docker/Podman config ownership, rootless UID, SELinux, remote, native
macOS/Windows or mount-race behavior. Retained native acceptance must supply
those proofs. This is only config preparation extraction; remaining M10 work,
M11–M14 and the full M00–M14 migration remain outstanding. Historical attestation
parks are not resolved by this packet.
