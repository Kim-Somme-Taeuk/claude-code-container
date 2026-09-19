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

**`Get-NetNeighbor` swallows real read failures.** The operation script uses
`-ErrorAction SilentlyContinue`, justified as "an interface with no neighbours
is the ordinary case" — true, but it swallows every non-terminating error, not
just no-match. The legacy path used `-ErrorAction Stop` and mapped the catch to
`hyper-v-bootstrap-neighbor-inspection-failed`. That code is still in the
broker's public union and is now unreachable. A real neighbour-read failure is
indistinguishable from an empty table: discovery silently loses one of its two
address sources and the create times out as `hyper-v-bootstrap-address-unavailable`
with no clue why. Fixing it means distinguishing no-match from error on the
PowerShell side. Either make the code reachable or remove it from the union;
leaving a public code that nothing can emit is the worst of the three.

**Empty host prefixes are reported as an inspection failure.** Discovery returns
`hyper-v-bootstrap-host-prefix-inspection-failed` when no host prefix is found.
In the PowerShell that code meant only "the `Get-NetIPAddress` read threw"; a
successful read yielding zero prefixes returned a clean empty with no diagnostic.
So this now names a failure for a state where nothing was inspected badly. The
typed path also drops `hyper-v-bootstrap-management-adapter-inspection-failed`
entirely. Fixing it needs a diagnostic for "no host address on this network"
distinct from "the read failed", which widens a closed union the broker consumes.

**Two copies of the interface filter.** The adapter picks which interfaces to
read neighbours on; the reconciler picks which host addresses count as prefixes.
The adapter's copy omits the reconciler's `prefixLength` bound. Safe today only
because the adapter's is strictly wider, and nothing pins that relationship. If
it ever narrows, neighbours on a legitimate interface are never read and
discovery silently loses half its sources.

**`resolveOwnedVm` cannot say "the VM is gone".** It reports
`hyper-v-vm-ownership-mismatch` both for a VM that is missing and for one that
belongs to someone else. Both codes exist and both are terminal, so behaviour is
unaffected, but an operator loses a real distinction.

**`confirmHyperVBootstrapContainment` reasons negatively over an absent value.**
A MAC that fails to parse decodes to absent, and absent matches nothing. That is
the right default for destructive selection and the wrong one for a containment
proof, which is asserting that nothing holds the address. Not reachable today,
since native always spells a MAC parseably.

**Defence-in-depth, from the security review, none exploitable.** The native
`Remove-VMNetworkAdapter` re-resolves the VM by id and re-checks adapter name and
MAC, but does not re-check the ownership marker, leaving a TOCTOU window that
requires host privileges to exploit. `observeForDiscovery` issues one neighbour
read per host interface with no cap (host configuration, not caller-controlled).
The host-prefix floor accepts `/8` where `createHyperVHostNetworkSpec` requires
`/16`-`/30`.

### A flaky test that will read as a mystery CI red

`device-lab-hyper-v-linux-broker.test.ts`, the "runs create, cloud-init, SSH,
transfer, snapshot, and cleanup through one owner-fenced backend" case, asserts
that the exhausted-boot readiness error is one of three codes. Under full-suite
load it intermittently produces a fourth, `hyper-v-bootstrap-network-probe-failed`,
and fails. Observed once in two full-suite runs on 2026-09-18; passes in
isolation and under artificial CPU load.

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

Two honest repairs, neither done here because both are a design decision rather
than a patch: make the case deterministic about whether the probe is allowed to
complete, so exactly one classification is reachable; or assert the property the
test actually means -- the boot budget was exhausted, the device is reported
not-ready, and specifically not as `hyper-v-guest-boot-signal-timeout` -- against
the classifier's own closed set of codes rather than a hand-maintained copy of
part of it.

**One `as unknown as` in the adapter test helper.** `client()` in
`device-lab-hyper-v-vm-network-adapter.test.ts` ends in a double assertion,
which defeats part of the point of adding that file to `tsconfig.tests.json`.
Pre-existing, from `6c7a59bd`.

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

**Five valid-but-wrong values still compile:** an empty `startupOrder`, a
duplicated one, `{enabled: true, template: ""}`, and a `managed-and-bootstrap`
intent whose two adapter names are equal. The client rejects the first three at
runtime; the fourth produces a plan that renames and adds the same name, which
native then refuses as ambiguous.
