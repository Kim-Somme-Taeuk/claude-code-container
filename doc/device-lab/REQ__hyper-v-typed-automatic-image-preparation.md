---
area: device-lab
slug: hyper-v-typed-automatic-image-preparation
status: current
---

# REQ — Prepare automatic Hyper-V images through typed VHD operations

## Supported profiles and compatibility

An actual `device_create` using the automatic `windows-server` or `ubuntu-lts`
profile MUST prepare the catalog image under the existing private profile root
and publish a version-3 manifest only after the image has been fully verified.
The catalog source, expected generation, license acceptance, source cache rules,
public parameters, response shape, deadline errors, and bounded diagnostics MUST
remain compatible. Dry runs MUST leave the host unchanged. A valid cached image
MAY be reused; an unmanaged base without a manifest MUST be preserved and
reported as a conflict rather than deleted or overwritten. A recognized prior
catalog manifest MAY be removed with its associated base for reacquisition only
after its profile, source provenance, exact path, size and file hash match.
Malformed or foreign manifests and their bases MUST remain untouched.
The validated prior pair MUST remain recoverable until the replacement manifest
commits. An interrupted retirement MUST be recovered before the next acquisition.

An omitted create profile MUST resolve to `windows-server` for Windows and
`ubuntu-lts` for Linux, including configuration checks on an existing device.
A matching repeat create MUST return that device without provider mutations.
An explicitly different profile, or conflicting requested base digest or source,
MUST still fail; an existing device MUST NOT determine the automatic default.

## Typed VHD boundary

The production automatic path MUST inspect every source, partial, and published
VHD through typed `Get-VHD`. Ubuntu preparation MUST use typed `Convert-VHD` to
convert the verified fixed VHD to a dynamic VHDX and typed `Resize-VHD` only when
the converted virtual size is below the catalog target. The fixed source MUST
have no parent and the expected virtual size. Every accepted partial and final
image MUST be VHDX, non-differencing, parentless, and the exact target virtual
size. Windows Server automatic preparation MUST likewise use typed `Get-VHD` to
validate its downloaded partial and published image.

Download, QEMU conversion and content comparison, hashing, ACLs, path ownership,
locking, manifest publication and public error mapping remain Device Lab and
host-control responsibilities. The low-level library MUST remain independent of
catalog profiles and Device Lab roots, and each typed mutation MUST target only
one native Hyper-V operation without an implicit retry.

## Failure and cleanup

The automatic transaction MUST apply one acquisition deadline across all phases
and typed operations, including conversion that can outlast the library's normal
short operation timeout. At every process boundary it MUST recheck exact paths,
non-reparse components, file identity and hash before trusting files created in
an earlier phase. A missing, mutated or malformed source or partial MUST stop
publication. An uncertain convert or resize outcome MUST NOT be accepted as
success solely because an output file exists.

On failure or timeout, cleanup MUST remove only transaction-owned partial and
work files, retain a valid bounded Ubuntu source cache, and preserve any
pre-existing base and manifest. Once finalization may have created a base, a
lost response or later validation failure MUST retain any unmanifested file for
guarded recovery; matching bytes or a later path stat do not prove ownership.
Pre-existing partial or work paths with unknown ownership MUST be preserved and
reported as a conflict until guarded recovery removes them.
Artifacts that appear during a failed process phase without a trusted response
MAY be moved to a unique retained path after file identity is checked. The move
MUST preserve their bytes and permit a clean retry; retained files MUST NOT be
silently deleted. If a prior image pair is backed up, an uncertain new base MAY
be retained in the same way so the prior pair can be restored.
No manifest may be published from an uncertain outcome, and a bounded,
redacted error MUST be returned. Public
diagnostics MUST NOT expose host paths or raw native output.

## Verification

Tests MUST cover both automatic profiles through broker routing, exact typed VHD
operation order and arguments, Ubuntu convert and conditional resize branches,
wrong VHD metadata, changed source/partial bytes, malformed or lost mutation
responses, deadline behavior, existing-base preservation, cleanup ownership and
no manifest after uncertainty. Static and package tests MUST cover the trusted
PowerShell asset. Linux simulation cannot prove native Windows Hyper-V behavior;
Windows-host acquisition remains a separate parent Goal requirement.
