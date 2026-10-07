# Shared tool launcher path extraction

## Shared tool launcher location (M11a candidate)

`src/domain/tool-layout.ts` now owns the existing fixed `CLAUDE_BIN_PATH` value,
`/home/ccc/.local/bin/claude`. Tool metadata imports this pure value directly.
Native setup imports and re-exports the same binding through its existing public
`src/container-setup.ts` path. Existing consumers retain that export and its
literal string type; setup uses the same value internally. The domain module
has no imports or runtime effects and falls under the recursive core guard and
architecture typecheck. No ports or execution framework are added for a constant.

The previous graph was `tool-registry -> container-setup -> tool-registry`.
Coordinator baseline probes in separate fresh Node processes reproduced a
compiled setup-first `ReferenceError: Cannot access 'CLAUDE_BIN_PATH' before
initialization`; registry-first succeeded. Both probes fenced native effects
and recorded zero effects. These probes used the unchanged compiled artifacts
from the prior verified candidate in the private execution copy. Their helper
reports failure as JSON while returning zero, so the post-change regression must
assert successful import explicitly rather than infer it from process exit.
The new graph has registry and setup both pointing to pure domain data; setup
still consumes the existing registry for installation metadata, but registry no
longer returns to setup or loads its native execution dependencies.

Registry interfaces, selectors, four tool definitions, flags, credential mounts,
install/update commands and shared object/array behavior remain unchanged.
Only its constant import changes. Setup changes only that import, the
compatibility export and its obsolete initialization-order comment. Existing
layout paths, native commands, timeouts, privileges and public functions stay
unchanged. Task baseline checks compare these shared files against their
pre-child dirty copies, so unrelated earlier edits are not treated as this task.

Verification anchors are the architecture tool-registry-layout source/type
suites, recursive core guard, existing registry/setup regressions and shared
workspace package verifier. Actual production imports must be tested in fresh
ESM processes for both first-entry orders, with native effects fenced. The
shared verifier runs these orders and actual public setup calls in both extracted
npm and materialized installation payloads, with declaration compatibility and
literal-type consumer checks. A Vitest module reset or miniature copied graph
cannot establish production ESM initialization behavior. Registry import tests
also prevent accidental installer/native dependency loading. Independent code
and documentation review plus fresh QA remain acceptance gates.

Known ceiling: inert setup calls and package import proofs do not certify real
native installation, host credential transfers, rootless/SELinux or macOS/Windows
runtime behavior. Those remain designated native acceptance lanes. This packet
breaks the constant dependency only; full registry metadata ownership, tool
probe/install applications, credentials/workspaces/profiles, remaining M10 work,
M12–M14 and the complete M00–M14 migration remain outstanding. Historical
attestation parks remain unresolved.
