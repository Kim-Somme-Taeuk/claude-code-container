# Typed Hyper-V library: routes and verification

The typed Hyper-V library is part of the `ccc` package. Its implementation is
under `packages/hyper-v/src/`; compiled entrypoints and the integrity-pinned
PowerShell assets travel in the root package. The separate npm package and an
external compatibility promise remain deferred in the source checkout's
`doc/hyper-v-windows/ADR__library-boundary.md`. The package requires
Node.js 20.19 or later (`package.json`). Hyper-V execution requires a Windows
host with the Hyper-V feature and Windows PowerShell; the privileged fixture
also requires administrator consent.

## Production route inventory

This inventory follows the broker's live dispatch, including failure routes.
A direct PowerShell call does not by itself mean the VM library boundary is
unmigrated: several commands build media, inspect Storage, or manage host setup.

| Route | Current owner | Next action |
|---|---|---|
| VM creation, status, power, deletion and orphan recovery | Typed `packages/hyper-v/src` operations composed by Device Lab | Keep typed identity and attachment fences. |
| VM bootstrap network discovery and teardown | Typed route using the PowerShell executable already selected for the VM lifecycle command (`device-lab-broker.ts`, `hyperVBootstrapNetworkSeam`) | Keep exact owner, managed MAC, and post-removal containment checks; run disposable-host proof. |
| Linux seed creation and VM seed-media attachment/boot setup | Device Lab builds cloud-init, keys and ISO; typed VM/network reads preflight identity, then `Configure-VMGuestBoot` with Linux policy attaches media and sets boot order | Run native PowerShell and disposable-host validation before claiming hardware proof. |
| Snapshot journal repair | Typed `Repair-VMSnapshotState` transaction, then typed status confirmation | Keep the owner-scoped journal until repair and state persistence are confirmed; run disposable-host proof. The older repair asset remains packaged for compatibility but has no live broker caller. |
| Hyper-V setup and readiness diagnostics | Device Lab admin/broker host-prerequisite commands | Keep outside per-VM typed mutation until there is a concrete shared primitive. |
| Create prologue and file compensation; image Storage inspection/finalization | Host filesystem, ACL, Storage and acquisition code | Keep outside the VM primitive library; preserve owner/path checks. |
| Windows provisioning media builder and Linux SSH/finalize | Guest media and guest transport code | Keep guest policy in Device Lab; Windows VM boot/media configuration already uses typed operations. |
| Legacy create/status/power/delete command builders | Dry-run projection and regression fixtures | Keep them out of live default dispatch. |

The standalone library host scenario predates guarded deletion and
`Remove-HostFiles`. A PASS from that scenario alone does not prove those newer
operations on Windows. Use the Device Lab Level 3 and durability scenarios on
a disposable Hyper-V host to cover the broker transaction as well.

## Verification tiers

| Host | Commands | Evidence |
|---|---|---|
| Linux or Windows development host | `npm run build`, `npm run lint`, `npm run test:hyper-v:package` | Type contracts, static checks, tarball consumer imports, compiled entrypoints and asset integrity. Package verification is non-destructive. |
| Windows with PowerShell | `npm run test:hyper-v:pester` | Installs exact pinned CurrentUser modules from canonical PSGallery when needed, then runs native PowerShell parsing, analysis and Pester checks. |
| Disposable Windows Hyper-V host | `npm run test:level3:hyper-v:windows:library`, `npm run test:level3:hyper-v:windows:network:library`, `npm run test:level3:hyper-v:windows`, then Device Lab durability as needed | Live VM, network, guest, rollback and cleanup behavior. These commands can request elevation and mutate the host. |

On Linux, `npm run build` prints a PowerShell parser SKIP, and the Level 3
Windows commands cannot prove a real host. Windows CI runs parser/Pester and
the non-destructive package test; CI does not stand in for a disposable
Hyper-V host. Record the actual host output before claiming the hardware gate
passed.

The test command prepares its modules idempotently and pins Pester 5.7.1 and PSScriptAnalyzer
1.24.0. It does not depend on PowerShellGet: each exact package is downloaded
from the canonical PSGallery package endpoint, checked with .NET SHA-256 against its pinned
SHA-256 and module manifest, then staged into the current user's Windows
PowerShell module directory. A failed download, hash check, or extraction does
not publish a partial module version. Existing versions are recognized through
the installer-owned hash marker in that exact CurrentUser directory; a broken
or unmarked copy is replaced through a same-directory backup and restored if
publication fails. Reparse-point module roots and trees are rejected before
replacement. After a successful import, backup retirement cannot roll back the
new module; an undeletable retired backup is reported as a warning. Run
`npm run test:hyper-v:pester` once to prepare dependencies and verify the PowerShell code.
The runner imports the exact CurrentUser manifest paths installed by that command,
so a fresh PowerShell process does not depend on module-name discovery through
`PSModulePath`.

The snapshot repair Pester cases pass explicit policy and observation functions
to the module. This keeps their virtual VM fixtures out of the native `Set-VM`
parameter binder while the module's default functions still call Hyper-V on a
real host. Guest boot diagnostics accept an initially empty error accumulator
when normalizing a valid integration service. Both corrections were exercised
by all 62 Pester cases on PowerShell 7. The 2026-09-23 Windows PowerShell 5.1
rerun also passed: parser validation covered 23 files, and Pester reported
62 passed, 0 failed, 0 skipped.

The library real-host fixture reports a bounded create stage when an unexpected
PowerShell exception occurs. For example, `create-name-query-failed` identifies
the exact-name precheck, while `create-root-protection-failed` identifies ACL or
integrity setup. These codes do not classify a native failure as VM absence.
Keep the token-scoped fixture root for inspection if guarded cleanup also fails.
For typed VM lookups, `ObjectNotFound` triggers a confirming inventory read;
an inventory failure remains an error rather than authorizing cleanup.
On hosts that report a missing valid VM name as `InvalidParameter`, the exact
Hyper-V GetVM error also triggers that confirmation read.
