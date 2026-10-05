---
area: device-lab
slug: hyper-v-network-teardown-identity
status: current
---

# REQ — Network-switch teardown ownership authority is the switch GUID

## Requirement
`hyperVCleanupNetworkCommand` (packages/device-lab/src/host-control/hyper-v/host.ts) MUST treat the
switch **GUID** (`$ExpectedSwitchId`) as the ownership authority, not the `Notes`
marker string:

```
if ([string]$Switch.SwitchType -ne 'Internal') { throw 'hyper-v-network-switch-ownership-conflict' }
if (-not $ExpectedSwitchId -and [string]$Switch.Notes -cne $Marker) { throw 'hyper-v-network-switch-ownership-conflict' }
```

The exact `Notes -cne $Marker` check is enforced ONLY when `$ExpectedSwitchId` is
absent (inspection-only paths). When present, switch identity was already
verified (the identity check throws `hyper-v-network-switch-identity-conflict`
unless the found switch's GUID equals `$ExpectedSwitchId`), so a matching GUID is
proof of ownership regardless of marker form.

## Why
The residue cleaned in E2E step 1 comes from many prior runs across code
versions. The SETUP path adopts/repairs owner-scoped switch markers and
recognizes BOTH the `stable` and `token` marker forms
(`$ObservedMarkerRecognized = $ObservedStable -or $ObservedToken`, with
token↔stable migration). So the switch's `Notes` legitimately drifts between
recognized forms. The teardown previously enforced an exact single-marker match
with none of that tolerance → false `hyper-v-network-switch-ownership-conflict`
that blocked residue cleanup even though the switch GUID matched.

## Invariant / consistency
- Ownership authority: switch GUID (`$ExpectedSwitchId`), verified before any
  mutation. Marker is secondary and expected to drift.
- For the removeSwitch path `$ExpectedSwitchId` is REQUIRED (host.ts guard), so
  identity is always available there.
- Safety retained: switch ambiguity (`Count -gt 1`), identity conflict, in-use
  deferral (attached adapters), and NAT/gateway identity checks are unchanged.
- Mirrors [[hyper-v-delete-disk-guard-subset]]: trust the strong identity proof
  (GUID / Notes marker / owned directory); do not let a secondary check that
  legitimate state variation can break veto owner-scoped cleanup.

## Regression coverage
- src/__tests__/device-lab-hyper-v-provider.test.ts asserts the split guard
  (unconditional Internal type check; identity-gated marker check).

## Explicit fabric preservation

Hyper-V `device_delete` accepts `preserveNetwork: true` for callers that will
reuse the verified shared host fabric. The broker MUST still remove the exact
owner/device/incarnation allocation and complete VM, file, artifact, metadata,
and journal cleanup. When that allocation is the last one, it atomically commits
an empty allocation list while retaining the managed switch, gateway, NAT,
their exact identities, and ownership receipts. It MUST NOT enter the
administrator/elevation path for that retained fabric. The public cleanup
observation reports `hyper-v-network-retained-by-request`.

Omitting the option keeps the existing last-allocation teardown contract. The
Windows disposable VM E2E uses preservation during residue and final cleanup
because it immediately reuses the same fabric; the dedicated Hyper-V network
real-host proof remains responsible for destructive exact-ID teardown coverage.

## Broker-internal compensation preserves fabric

Releases the broker makes on its own behalf MUST retain the managed fabric the
same way: failed-create rollback, create-residue recovery, and operation-journal
replay ahead of any command other than `device_delete`, including
`device_create`. Each removes the device's exact allocation row immediately, so
a failed create leaves no orphan allocation, never needs Administrator, and so
never raises UAC. Journal replay ahead of `device_delete` follows that command's
own `preserveNetwork`.

Only an explicit `device_delete` without `preserveNetwork` tears down the last
allocation's switch, gateway, and NAT. Create-residue recovery for a device with
no recorded incarnation also stays destructive: preservation requires a matching
incarnation and would otherwise report
`hyper-v-network-allocation-incarnation-conflict`. The fence is
`hyper-v-setup-network-v11`; a v10 broker tears the fabric down after a failed
create.

## History
- v1: exact `SwitchType -ne 'Internal' -or Notes -cne $Marker` → rejected
  owner-scoped residue whose marker form drifted. Superseded.
- v2 (current): identity-gated — switch GUID governs when available.
- v3: explicit allocation-only release may retain verified managed fabric for
  immediate reuse; ordinary delete teardown is unchanged.
- v4: broker-internal compensation always retains the managed fabric; only an
  explicit `device_delete` without `preserveNetwork` tears it down.
