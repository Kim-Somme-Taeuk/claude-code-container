# Typed Hyper-V deletion and orphan recovery

Device Lab removes Hyper-V VMs and their owner-scoped artifacts through typed
Windows library operations. This applies to normal device deletion, a pending
delete journal, creation failure compensation, orphaned creation residue, and
an ID conflict rollback. Dry-run may continue to display the compatible
PowerShell projection without executing it.

## VM authority

- A normal deletion targets the stored VM GUID and requires the canonical
  owner/device/incarnation name and exact Notes marker. The selected VM's hard
  disks must be the expected disks or lie inside its canonical owned disks
  directory; attached DVD paths must be expected provisioning media. This
  admits checkpoint differencing disks under the owned directory while
  rejecting foreign attachments.
- Orphan recovery may select the exact canonical name when no stored VM GUID
  exists. A marked VM uses the same disk and DVD guard as normal deletion. A
  VM with empty Notes may be removed only when it has exactly one hard disk,
  that disk is the expected root.vhdx, and it has no foreign DVD media.
- Device Lab inspects ownership before changing VM state. Native PowerShell
  re-resolves the exact GUID and repeats the name, Notes and attachment checks
  immediately before Remove-VM. A missing, ambiguous or changed identity
  cannot authorize mutation. An absent GUID with a same-name VM is a conflict.

## Transaction and recovery

- Stop a live owned VM with a turn-off request, confirm it is Off, then issue
  guarded Remove-VM. A successful delete requires a fresh read proving that
  neither the GUID nor the owner-scoped name remains. A lost stop or removal
  response is uncertain; the broker retains its journal and uses read-only
  reconciliation before any further mutation.
- Only after VM absence is proved may cleanup remove expected disk and media
  files and owned checkpoint .avhdx files. File cleanup rejects reparse points
  in every path component and refuses non-file targets. Network allocation
  release, private-root cleanup and state removal keep their existing order
  and recoverable failure behavior.
- Public delete and orphan observations retain their current fields and fixed
  error meanings. No raw host exception text, credentials or private paths
  enter public responses.

## Verification

Low-level, adapter and broker tests cover marked and unmarked ownership,
checkpoint disks, foreign disk/DVD refusal, identity replacement, absent VM
and same-name conflict, reparse paths, uncertain responses and cleanup failure.
Static Linux checks do not prove native PowerShell parsing or live Hyper-V
behavior; native Windows proof remains a parent Goal gate.
