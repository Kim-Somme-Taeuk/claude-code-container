---
area: device-lab
slug: hyper-v-typed-status
status: current
---

# REQ — Typed Hyper-V status

Device Lab status, snapshot reconciliation, snapshot list, and snapshot creation
preflight read a VM through the typed Hyper-V library. Every read is limited to
the stored VM ID and checks its exact name and opaque ownership Notes before
publishing an observation. Disks and snapshots returned by later reads must
belong to that same VM.

The status observation keeps the VM state, status, uptime, checkpoint policy,
first disk's base path, and owner-prefixed snapshot list. When the active disk is
a checkpoint differencing VHD, the base path follows `ParentPath` to the root
as required by [the existing base-disk contract](REQ__hyper-v-status-base-disk-of-chain.md).
A missing VHD or native VHD metadata read error retains the active path as the
legacy status command did. Reparse-point rejection, ambiguous results,
malformed responses and transport timeouts fail the transaction.
Snapshot paths still reject the fallback if it differs from the expected owner root.
Cycles or excessive chain depth fail the status transaction.

The four reads share one deadline. Identity changes, malformed records, native
read failures and timeouts do not publish a partial status. Public status and
snapshot responses retain their existing fields and bounded error classes;
host paths and native exception text are not exposed in errors.

## Verification

Test the four production call sites with exact and wrong owner Notes, nested
checkpoint chains, empty and mixed disk/snapshot records, VHD read failures,
cycles, timeouts, and public response redaction. Linux mocks do not satisfy
the parent Goal's native Windows Hyper-V proof gate.
