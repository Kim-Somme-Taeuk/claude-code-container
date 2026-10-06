# Explicit container stop/remove extraction

Explicit container stop/remove authorization, cleanup and dispatch ordering now
run through an application service with required synchronous ports. Native
composition retains current runtime selection, exact messages/errors, inherited
stdio and plain removal by proven ID. Raw claims stay inside the existing
lifecycle lock; force bypasses only the claim veto and never managed identity
verification. Public arguments, default options, void results and legacy partial
failure behavior remain unchanged.

Portable core/type/facade regressions cover the extracted boundary. Distribution
smoke exercises the actual compiled application in extracted npm packages and
materialized installs, including ordered stop/remove, claim refusal, forced
null-identity refusal and cleanup-failure continuation. Composition/public facade
imports and construction are checked with native subprocess probes fenced.
Independent review and final QA determine acceptance. The full M00–M14 migration,
remaining container cutovers and M02c attestation are still outstanding.

## Known ceiling

Known ceiling: plain removal and synchronous native command results preserve
legacy failure semantics without an operation receipt or unknown-outcome
reconciliation — upgrade during the approved native outcome/CAS work.

Known ceiling: portable fixtures and package smoke do not certify native
Windows/macOS, PowerShell parsing, Docker/Podman, rootless UID/SELinux or remote
runtime behavior — upgrade when disposable native runtime lanes provide actual
operation and handoff receipts.
