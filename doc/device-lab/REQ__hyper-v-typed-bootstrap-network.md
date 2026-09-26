---
area: device-lab
slug: hyper-v-typed-bootstrap-network
status: current
---

# REQ — Typed Hyper-V Linux bootstrap network

## Live route

Linux VM start and reboot with boot waiting MUST use the typed Hyper-V Windows network client for bootstrap address discovery and adapter teardown. The client MUST use the PowerShell executable selected for that VM lifecycle command. A missing executable MUST fail before a bootstrap host call; the broker MUST NOT substitute an unverified command name or run the legacy bootstrap scripts.

An injected command runner MUST receive the typed operations directly. The default runner MAY use its existing pooled PowerShell session. Bootstrap operations MUST NOT request administrator elevation.

## Discovery and teardown

Each probe MUST recheck the VM's exact ID, name, and ownership Notes before reading its network adapters. A missing exact-name VM MUST remain distinguishable from an ambiguous or ownership-mismatched VM. An empty address result without a diagnostic means the guest or host bootstrap address may still be unavailable and is retryable within the boot deadline. A failed native read, invalid result, or owner mismatch MUST remain a failed probe rather than be interpreted as an empty successful result.

The native IPv4 neighbor read MUST remain scoped to an inspected bootstrap
interface. An ordinary no-match result for that exact read MAY be an empty
neighbor set. A different native or transport read failure MUST produce the
existing `hyper-v-bootstrap-neighbor-inspection-failed` readiness code, even
when another address source is available. Error classification MUST use the
PowerShell error category and exact cmdlet error identity; localized message
text or a broad `ObjectNotFound` category alone is insufficient evidence of
an empty neighbor set.

Host addresses qualify for both subnet discovery and neighbour reads through
one shared rule: they MUST identify the bootstrap management interface and use
a /16 through /30 prefix. At most 16 unique qualifying interfaces may be read
in one probe. Exceeding that bound MUST fail before the first neighbour call.

Teardown MUST select only the owner VM's expected bootstrap adapter and managed MAC. The native removal request MUST carry the expected ownership Notes and re-read the selected VM immediately before mutation; changed Notes MUST refuse the removal. An already absent adapter is idempotent. After an attempted removal, the broker MUST confirm that no host adapter still carries that MAC before reporting cleanup success. A failed or uncertain removal MUST NOT be blindly replayed.

The caller MUST keep its existing deadline caps and public readiness shape. A missing or failed cleanup observation MUST preserve the failure-containment behavior: a running VM is stopped or reported as not contained, never reported ready with a retained bootstrap network.

## Verification

Fake-host tests MUST cover success, retryable empty discovery, owner drift, adapter ambiguity or wrong MAC, native or transport failure, teardown containment, and the absence of live legacy bootstrap dispatch. Linux simulation does not prove native Windows PowerShell or a real Hyper-V host; those remain separate evidence.
Windows validation MUST exercise a genuinely empty interface-scoped neighbor
query and a distinct injected read failure before claiming native no-match
classification is proven.
