# Existing container lifecycle extraction

Existing container reuse, safe update deferral, restart and identity-fenced replacement now run through an application service with explicit synchronous ports. The public container start API, preparation, shared handoff checks and fresh creation behavior remain unchanged. Native execution and presentation are bound in composition. Portable regression and extracted/materialized package checks exercise the migrated behavior; independent review and final QA determine acceptance.

## Known ceiling

Known ceiling: plain removal and synchronous native command results preserve legacy failure semantics without an operation receipt or unknown-outcome reconciliation — upgrade during the approved native outcome/CAS work.

Known ceiling: portable fixtures and package smoke do not certify native Windows/macOS, PowerShell parsing, Docker/Podman, rootless UID/SELinux or remote runtime behavior — upgrade when disposable native runtime lanes provide actual operation and handoff receipts.
