# Explicit tool catalog and pure selection

## Explicit tool catalog domain (M11b candidate)

`src/domain/tool-registry.ts` owns canonical `ToolDefinition` and
`CredentialMount` contracts, the existing four default descriptors, and pure
selection/projection functions. `createDefaultToolCatalog()` returns a fresh,
independent graph on each call, including descriptor objects, flags/commands,
optional subcommand arrays, mount arrays and mount objects. Existing values and
order stay unchanged. The module imports only the shared pure launcher location.
It has no module catalog, environment/home/platform observation, execution port,
implicit default selector argument or installation effect. Command strings and
host-directory hints remain passive metadata.

`findToolByName(catalog, name)`, `findDefaultTool(catalog)`,
`getAllCredentialMounts(catalog)` and `getNpmTools(catalog)` require caller-owned
catalogs. They preserve the existing `find`, `flatMap`, `filter`, `map`,
`startsWith` and `replace` expressions. Lookup returns the first matching
reference; unknown, empty, case-mismatched and missing-default queries retain
undefined outcomes. Credential projections allocate a new outer array while
preserving mount references. Npm projections allocate new arrays and records,
filter by the exact prefix and use each tool's name rather than its binary.
No trimming, normalization, validation, caching, catch, retry or freeze is added.
Live Array/string methods, their receivers, field-read order and original thrown
values remain observable; overridden results are not normalized or awaited.

The existing `src/tool-registry.ts` path remains a compatibility/composition
facade. It creates exactly one catalog at module initialization and forwards
existing public functions to the explicit selectors. `getAllTools()` returns
the same mutable array, and all getters share its descriptor graph. Push/remove,
reordering and property edits remain visible on subsequent queries. The old
`getDefaultTool(): ToolDefinition` static signature retains its nonnull assertion,
while removal or renaming of Claude can still return undefined at runtime.
The domain default lookup exposes the nullable result explicitly. Other callers
and native setup/install behavior remain unchanged; M13 still owns eventual
composition closure.

The old metadata type exports are re-exported from canonical domain interfaces.
An actual emitted-declaration consumer tested optional interface augmentation
through the old path before and after the change, including nested/direct mount
fields and tool fields. Both compiled without a compatibility bridge. Uncalled
source contracts verify mutual assignability, mutable nested fields, required
catalog/query inputs, optionality and legacy/domain return types. TypeScript
source imports alone are not delivered declaration evidence.

Verification anchors are the architecture tool-registry-domain policy, facade
and types suites, existing M11a defaults/native-isolation/installer tests,
recursive domain guard, and shared workspace package verifier. Domain tests use
custom catalogs and deliberate getter/method overrides; facade tests use actual
modules and restore shared state. The package verifier must execute actual
compiled domain and public facade in both extracted npm and materialized
installation forms, with real declaration consumers. Existing M11a fresh cold
import orders, explicit successful imports, native fences and public ensureTools
VALID/INSTALL proofs remain required. Independent code/docs review and fresh QA
remain acceptance gates.

Known ceiling: pure metadata, inert native functions and compiler/package checks
do not certify host discovery, real installers, credentials, native
macOS/Windows/Docker/Podman, rootless/SELinux or remote providers. This packet
addresses catalog construction and selection ownership. Tool probe/install/launch
applications, preferences/discovery, workspaces/profiles/credentials, remaining
M10 and Device Lab migration, M12–M14 and full M00–M14 acceptance remain
outstanding. Device Lab capability-registry contracts are a separate surface;
this preserved legacy tool-catalog mutability does not change them.
