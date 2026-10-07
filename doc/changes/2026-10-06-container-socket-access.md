# Container socket access policy extraction

## Container socket access policy (M10l candidate)

`createContainerSocketAccess` moves socket-access decisions and warning state
into `src/application/container-socket-access.ts`, behind required synchronous
`ContainerSocketAccessPorts`. Probe and grant ports return raw status observations;
probe output remains `unknown`. The warning port returns `undefined`.
Construction checks probe, grant, then warn callability without native effects.
Missing capabilities throw `TypeError`; capability getter failures propagate.
`run(target)` and `resetWarning()` return `undefined`, use live port lookups and
preserve their receiver. The application has no native imports or ambient state.

A probe first reads status. Zero returns without reading output. Other statuses
read and stringify output, trim and split whitespace, then read status again.
Only status 10 with the existing username and decimal GID regex permits grant.
The first two tokens are used unchanged, including leading-zero GIDs; surplus
tokens remain ignored. Grant classification reads its status only. Native
`.error` fields remain unobserved. Dispatch, getter and coercion failures escape
with their original thrown value; returned failures warn and continue.

Warning state advances before the warning effect, including when that effect
throws or reenters the application. It suppresses later warnings across targets
until reset, while probes and grants still execute. Independent application
instances have independent state. Docker composes exactly one private instance,
so existing module-wide lifetime and the public reset hook remain unchanged.

Docker remains the temporary native composition root until M13. It retains both
exported fixed scripts, default-user probe, root grant, separate late runtime
selection, exact argument arrays and stdio. Both native operations retain the
10-second timeout; grant retains the inner 8-second timeout with 2-second kill
grace. The existing index setup caller still passes the final selected target.
No caller authority, privilege, retry or permission policy changes.

Verification anchors are the architecture socket core/type/facade suites and
shared `scripts/test-workspace-packages.mjs` socket verifier. Core tests cover
validation, observation order, input boundaries, exception identity and warning
lifetime. Facade tests execute actual Docker/application/runtime modules with
native effects fenced. The package verifier executes compiled core and actual
public facade in both extracted npm and materialized install payloads, including
strict declarations. Independent code/security/docs review and fresh QA remain
acceptance gates; developer test success alone is not final acceptance.

Known ceiling: portable native-boundary fixtures do not certify real socket
permissions, native macOS/Windows, rootless UID/SELinux or remote providers.
Retained native acceptance must supply that evidence. This candidate is only
socket policy extraction; M10 remaining seams, M13 composition closure, M14
acceptance and the full M00–M14 migration remain outstanding.
