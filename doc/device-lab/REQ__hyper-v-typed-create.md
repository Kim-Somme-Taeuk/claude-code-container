---
area: device-lab
slug: hyper-v-typed-create
status: current
---

# REQ — Route Hyper-V VM creation through the typed library

## Requirement

An actual `device_create` for `windows-vm` or `linux-vm` MUST create and configure
the VM through the internal typed Hyper-V client. It MUST NOT execute the legacy
generated `hyperVCreateCommand`. The public MCP tool, CLI options, owner-scoped
broker route, and response shape remain the same. A successful response MUST
identify the VM that Hyper-V created, with the expected owner-scoped name,
generation, independent cloned VHDX path, and resolved switch. Windows guest
provisioning and Linux seed creation MUST use that verified identity before the
owner device record is claimed.

The transaction MUST check host capacity, free disk space, source identity and
hash, VHDX format and parent, safe paths and Windows reparse tags, restrictive
directory ACLs before copying, switch identity, and bootstrap MAC conflicts.
It MUST copy the verified base image to a new per-device VHDX without changing
the cached base. The copied disk MUST be read back and verified before `New-VM`.
Base and copied-disk VHD metadata MUST be read through the typed `Get-VHD`
operation. Device Lab MUST reject a result for a different path, a non-VHDX
format, a differencing disk, a parent chain, an invalid virtual size, or a
copied-disk size different from the base. The native operation MUST check all
Windows reparse tags on the path before and after inspection.
The VM MUST have the requested generation, memory and CPU count, disabled
dynamic memory and automatic checkpoints, the owner Notes marker, the expected
network adapters, and the cloned disk attached as its boot disk. Windows keeps
`ProductionOnly` checkpoints and its requested Secure Boot setting; Linux keeps
`Production` checkpoints and Secure Boot off. Attachment, boot order, and
bootstrap MAC ownership MUST be checked before creation reports success.

## Failure and retry contract

- A dry run MUST leave the host unchanged and retain the existing redacted
  planned result, including the public Hyper-V provider summary. Repeating
  create with the same immutable configuration MUST return the existing
  owner-fenced device; a conflicting configuration remains an error.
- A determinate failure after mutation MUST attempt compensation in reverse
  order: remove the VM by the ID returned by `New-VM`, delete the disk created
  by this transaction, then remove only directories this transaction created
  and that are empty. If VM removal fails or is uncertain, the attached disk
  and directories MUST remain for guarded orphan recovery. Other cleanup
  failures MUST NOT replace the original failure. Windows path compensation
  MUST check all reparse tags on the target and its parents in the native host
  command before removal; a Node symlink check alone is insufficient.
- A copy that fails after an exclusive destination open MUST still count as a
  created file and be eligible for compensation. An existing disk or directory
  MUST NOT be recorded as newly created or deleted. Open copy handles MUST be
  closed before attempting disk deletion. A prologue failure after creating a
  directory MUST account for and clean up only its own directories.
- If a typed `New-VM` response is lost after the host may have created a VM,
  creation MUST NOT blindly retry `New-VM`. It MUST use identity-fenced orphan
  reconciliation. The broker's existing cleanup time reserve applies to every
  create failure, including deadline expiry, guest setup failure, and owner
  state claim failure.
- Public failures MUST retain bounded status, diagnostic detail, and rollback
  fields. MCP and CLI output MUST redact credentials, host paths, PowerShell
  input, and other private provider data. A typed error MUST NOT leak those
  values or become an unstructured exception.

## Boundary and proof

The typed library owns Hyper-V VM, adapter, and Get-VHD operations; Device Lab
owns image copy, owner identity, paths, deadlines, guest setup, state, and public
mapping. No new public tool, backend,
CLI flag, or persistence schema is required.

Regression coverage MUST exercise Windows and Linux broker creation through
typed operations, dry run and idempotency, partial copy and each post-create
failure, ambiguous `New-VM`, rollback independence, redacted MCP/CLI responses,
and the packaged Device Lab MCP path. Mocked tests prove routing and contracts;
real Windows-host creation and durability remain separate hardware evidence.
