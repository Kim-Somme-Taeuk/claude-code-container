# Open findings in the typed Hyper-V library

Findings raised by review that were judged real but deliberately not fixed in
the slice that surfaced them. Each says why it was deferred, so a later slice
inherits the reasoning rather than rediscovering the problem.

This lives here rather than in the task directory because `doc/harness/tasks/`
is gitignored: a finding recorded only there is lost the moment the task
directory is cleaned, which is exactly when someone would want it.

## From the slice 2B review (2026-09-18)

Independent read-only review of `24aaefcc..e8c6c628`. Code review returned FAIL
on two findings, security review returned PASS with no exploitable findings, and
a re-review of the fixes (`78859a4a`, `7f1f2d65`) returned PASS.

Fixed at the time, each pinned by a test that fails when the fix is reverted:
teardown reading host state it never decides from; the dropped neighbour `State`
filter; two disagreeing IPv4 validators. The rules those established are in
`ADR__library-boundary.md` under "What slice 2B settled".

### Still open

**`Get-NetNeighbor` read failures: addressed in source, Windows proof pending.**
The operation script previously used `-ErrorAction SilentlyContinue` without
checking the error stream, so a provider failure was indistinguishable from an
empty neighbor table. It now captures nonterminating errors, accepts only an
exact cmdletization no-match error for an empty result, and fails closed for
every other error. The Device Lab adapter maps a failed typed neighbor read to
the existing `hyper-v-bootstrap-neighbor-inspection-failed` readiness code.
Fake-client and PowerShell fixture coverage pin those branches. The precise
native no-match ErrorRecord still needs a Windows interface-scoped probe;
unknown IDs fail closed until that evidence is available.

**Resolved: empty host prefixes are retryable availability.** A successful host
read yielding zero eligible prefixes now returns an empty result without a
diagnostic, matching the earlier behavior and allowing the caller's existing
address-availability timeout to classify the outcome. Native read failures still
fail the probe.

**Resolved: one interface filter.** Discovery and per-interface neighbour reads
now share `selectHyperVBootstrapHostAddresses`, including the supported /16
through /30 prefix rule. The adapter refuses more than 16 unique qualifying
interfaces before issuing any neighbour request.

**Resolved: `resolveOwnedVm` distinguishes absence.** Zero exact-name matches
report `hyper-v-vm-not-found`; ambiguity, changed ID, and changed Notes remain
`hyper-v-vm-ownership-mismatch`.

**`confirmHyperVBootstrapContainment` reasons negatively over an absent value.**
A MAC that fails to parse decodes to absent, and absent matches nothing. That is
the right default for destructive selection and the wrong one for a containment
proof, which is asserting that nothing holds the address. Not reachable today,
since native always spells a MAC parseably.

**Resolved defence-in-depth items.** Native `Remove-VMNetworkAdapter` now carries
the expected Notes and rechecks the current VM identity immediately before the
exact adapter mutation. Discovery caps qualifying interfaces at 16, and its
shared host-prefix filter accepts only `/16` through `/30`.

### Resolved: exhausted-boot test classification under load

`device-lab-hyper-v-linux-broker.test.ts`, the "runs create, cloud-init, SSH,
transfer, snapshot, and cleanup through one owner-fenced backend" case, asserts
that the exhausted-boot readiness error is one of three codes. Under full-suite
load it intermittently produces a fourth, `hyper-v-bootstrap-network-probe-failed`,
and fails. Observed once in two full-suite runs on 2026-09-18; passes in
isolation and under artificial CPU load.

Frequency, updated 2026-09-19: 3 of 4 full-suite runs that day, against 1 of 2
when first observed. Two sessions, but the same checkout and the same
homedir-scoped broker state, so most likely one host — which makes it a stronger
load-dependence signal than the same ratio spread over two machines would be.
One session hit it on its first run and not on its second with no intervening
change to that test, so it is not commit-dependent.

**It is not a slice 2B regression.** The classifier branch that emits it
(`device-lab-broker.ts`, `bootstrapProbeAttempts > 0 && bootstrapProbeSuccesses === 0`)
predates the 2B migration commit. The operation stubs in the test are
deterministic; what varies is only whether the bootstrap probe finishes inside
the shrinking remaining budget, since the case runs with `bootTimeoutMs: 1000`.
Under load it does not, so successes stays 0 and the classification flips.

**Do not fix it by adding the fourth code to the list.** That list has already
been widened once for exactly this reason, when
`hyper-v-bootstrap-address-unavailable` was added; this would be the third
outcome the same race has produced, and the list would still not be closed. The
test is pinning a timing-dependent classification against a 1 s budget and
calling it a fixed set.

Resolved in slice 4A: the assertion now checks that the response is not-ready,
has a nonempty readiness error, and specifically is not
`hyper-v-guest-boot-signal-timeout`. It no longer copies a timing-dependent
subset of classifier codes.

During slice 5A full-suite verification, a separate host-key rejection case
exposed another classification race. Several bootstrap probes succeeded and SSH
reported `ssh-host-key-rejected`, but the final probe failed near the caller's
deadline. The generic final `hyper-v-bootstrap-network-probe-failed` code then
masked the observed SSH failure. The classifier now preserves the SSH error when
at least one probe succeeded and a later generic probe failure follows an SSH
attempt. The integration fixture allows 10 seconds for this classification;
the previous 1-second budget could expire before the first probe under load.

**Resolved: adapter seam is narrow enough to test directly.** The production
adapter accepts the exact client method subset it calls, and the test helper now
type-checks without `as unknown as`.

## From the slice 3A review (2026-09-18)

Code review returned FAIL on four findings; all four were fixed. The ones below
were judged real and deliberately left for the slice that owns the creation
transaction, because each is about executing the plan rather than producing it.

**Three legacy checks cannot be hoisted ahead of the plan.** The contracts file
says non-mutating inspection belongs to the caller, which can refuse before
anything starts. That is true of host capacity, ACLs and path checks; it is not
true of these, which can only run partway through:

- the bootstrap MAC conflict re-read after the adapter is addressed, which is
  race detection between two devices deriving the same `06:` address;
- the created-disk attachment check. It survives only incidentally and only for
  generation 2, because the `Set-VMFirmware` branch resolves the disk by path.
  A generation-1 VM goes to `Set-VMBios`, which resolves no disk, so for
  generation 1 the check is gone outright;
- the boot-order verification after firmware is set. 3A ships the primitive
  (`getVMFirmware`) but no step kind can express a verification, only a mutation.

A creation plan that can only describe mutations cannot describe its own
preconditions. Whether verification becomes a step kind or stays the executor's
job is the design question 3B opens with.

**Stream disposal is a precondition of the disk delete, not just cleanup.** The
legacy rollback disposes three file streams before deleting the disk, and the
copy target is opened `FileShare::None` — so the delete takes a sharing
violation if the handle is still open. Omitting the streams as *effects* is
right (they are execution-time resources, not host residue), but the ordering
obligation is real and is not stated in the compensation contract, which does
spell out three other executor obligations.

**The compensation contract does not carry the guards the legacy delete had.**
Legacy wraps each rollback delete in `Assert-NoReparsePath` and uses
`-Recurse -Force`. `delete-directory` says neither whether it is recursive nor
that the path must not be a reparse point. A compensation that follows a
junction out of the device root is the failure that guard exists to prevent.

**A departure worth recording rather than fixing.** Legacy deletes the disk
path unconditionally on failure, with no equivalent of `$DeviceRootExisted`, so
it would delete a pre-existing disk when `CreateNew` failed. The effect-derived
plan cannot do that, because a disk it did not create produces no effect. That
is an improvement, not a port error.

**The ownership marker is written late.** `set-vm-settings` carries it, and it
runs after processor and memory, matching the legacy exactly. Until it runs the
VM exists and orphan recovery cannot recognise it as ccc's. The legacy has the
same exposure so 3A matches it, but whether creation should write the marker
immediately after `New-VM` belongs to the slice that owns the transaction.

**The effect-recording timing is a stated obligation with no executor to test it
against.** `HyperVCreateEffect` now says `directory-created` and `file-created`
are recorded the moment the host object comes into existence, not when the step
succeeds — the distinction that decides whether a half-written multi-gigabyte
VHDX survives a failed base-image copy. 3A ships no executor, so nothing
exercises it. The first 3B executor test should assert that a `copy-base-image`
which fails after creating its destination still records `file-created`, and
therefore still gets its `delete-file`.

**`ensure-directory` has a second, narrower version of the same window.**
If 3B executes it as the legacy did, with `New-Item -Force`, it creates
intermediate parents, so a nested create could leave a parent behind while
failing on the leaf, and only one `directory-created` effect would name the
leaf. Parity rather than regression: the legacy rollback removed `$DeviceRoot`
recursively and nothing above it.

It would stop being invisible the moment a `diskPath`'s directory sits more than
one level below `deviceRoot`; today's shape puts it directly under, so there are
no unrecorded intermediates at all. Depth is the trigger, not containment --
`deviceRoot\a\b\root.vhdx` is inside `deviceRoot`, passes the legacy's
`assertPathInside`, and still leaves `a` unrecorded. A `diskPath` outside
`deviceRoot` is the worst instance rather than the condition, since then the
intermediates are not even under a directory the device-root delete might reach.

**Constructing an effect is knowledge every executor repeats.** `effectKindOfStep`
answers with a kind, but `vm-created` carries a `vmId` and the other two carry a
`path`, so an executor still branches on the kind to build the effect it records.
This is inherent — only the executor holds the id or the path — and the union
keeps it type-safe, so it is recorded as a seam to expect rather than a defect to
fix. Found by compiling a 3B executor skeleton against the public barrel.

**Five valid-but-wrong values still compile:** an empty `startupOrder`, a
duplicated one, `{enabled: true, template: ""}`, and a `managed-and-bootstrap`
intent whose two adapter names are equal. The client rejects the first three at
runtime; the fourth produces a plan that renames and adds the same name, which
native then refuses as ambiguous.

## From the 2026-09-25 host Level 3 run

**Fixed: the automatic-image finalizer never ran on Windows PowerShell 5.1.** It
computed the partial image's file id with `[ulong]`, a type accelerator that exists
only in PowerShell 6+. The broker runs its scripts through `powershell.exe` (5.1),
so the finalizer threw before reading `base.partial.vhdx` and both Windows and
Linux creates failed as `hyper-v-base-image-partial-open-failed` after a complete
download. Earlier host runs never reached this path because the base images were
already cached. A host probe confirmed that, spelled `[UInt64]`, the Win32 file index
equals Node's bigint `ino` on NTFS, and that a VHDX can be moved immediately after
`Get-VHD`. `device-lab-hyper-v-provider.test.ts` now rejects PowerShell 7-only
accelerators in every `src/host-control/hyper-v` script builder.

**Open: the stage name hides the real error.** The finalizer's identity check
(`hyper-v-base-image-partial-identity-changed`) and any failure before the first
`Set-CccAcquireStage` are reported under the `partial-open-failed` stage, and the
failed-run cleanup deletes the partial image, so nothing is left to inspect.
