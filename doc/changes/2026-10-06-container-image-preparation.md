# Container image preparation extraction

Public `ensureImage(): void` now delegates through a required synchronous
application and native composition. Image existence/version decisions, ordered
pull/tag, existing-image fallback and absent-image failure handling moved
inward. Native helpers, diagnostic text and streams, stdio, registry authority,
runtime observation timing and the caller's preparation position retain their
behavior. The entire Docker facade outside one import and this function body
matches the retained pre-cutover baseline.

The application validates all 11 callable ports without effects, keeps request
facts lazy and calls current methods through their receiver. Null development
labels and matching versions return before unnecessary fact reads. Stale
version comparison, reporting and remote reference read version separately;
registry is read after the report. Successful tagging reads the local target
late, while failure reuses the captured qualified reference and original
existence observation. Error and non-Error values escape unchanged. Exit is an
`undefined` effect so an intercepted fixture may return.

Composition accepts the existing helpers and a required lazy registry getter.
The facade supplies its immutable utils binding, preserving the module-load
`CCC_REGISTRY` snapshot without leaving an orphan import. Image name/version
use existing utils exports. Native helpers observe the current runtime
independently; the local build hint resolves runtime after the error message.
There is no new probe, retry, cache, cleanup or composition-to-facade cycle.

Coordinator source verification recorded architecture types and 391 focused
core/boundary tests, then a full build, four-source lint and 39 prescribed
regression files with 2337 passing tests. Source hashes remained stable through
verification and the complete Docker bytes outside the cutover matched the
baseline. Built CLI help/version/invalid-runtime checks returned 0/0/1, version
1.1.90 and the established invalid-runtime diagnostic. These are portable
implementation checks; independent review and fresh QA remain required.

The shared distribution smoke adds actual compiled application/ports/composition
checks to both extracted npm packages and materialized installs. It covers all
image branches, reachable callback and lazy fact failures, required synchronous
declarations and the unchanged public signature. Six child-process functions
are fenced and ESM builtin bindings synchronized before importing the compiled
modules and Docker facade. Composition construction and a development-image
return must not execute native probes or read registry. Prior creation,
destruction, existing-container, claims and cleanup checks remain. Coordinator
package verification passed for both forms; independent review and fresh QA
remain pending.

## Known ceiling

Known ceiling: existence remains stdout-based despite status/error, and failed
inspection still yields a nullable label — upgrade when an approved image
evidence policy distinguishes unknown observations.

Known ceiling: failed pull retains the original local fallback, native tag
results remain ignored and completed image writes have no rollback — upgrade
when approved publication/reconciliation semantics require stronger evidence.

Known ceiling: portable fixtures and package smoke cannot establish native
Windows/macOS, PowerShell, Docker/Podman, rootless UID/SELinux or remote behavior
— upgrade when retained native acceptance gates run against actual source and
artifact hashes. The portable build explicitly skipped the unavailable native
PowerShell parser check.

Runtime readiness, other preparation, shared finish/handoff, setup/credentials,
host facts, cache ownership, reliable outcomes and identity-fenced claim release
remain M10 work. Full M00–M14 acceptance and native lanes remain outstanding;
this packet does not resolve independently blocked M02c attestation or complete
the architecture migration.
