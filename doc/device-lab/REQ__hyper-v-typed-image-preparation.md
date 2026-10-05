---
area: device-lab
slug: hyper-v-typed-image-preparation
status: current
---

# REQ — Prepare imported Hyper-V images through typed VHD operations

## Imported image behavior

An actual Windows or Linux VM `device_create` with `--source-image` MUST stage a
regular VHDX from the project root into the owner's private image area. The
source MUST satisfy the existing size, symlink, hardlink, identity, and hash
checks. A dry run MUST leave the host unchanged. An existing base image with
different bytes MUST retain the existing profile-conflict response and remain
untouched; the same bytes MAY reuse it after validation.

The imported preparation path MUST read VHD metadata through the typed
`Get-VHD` operation. Device Lab MUST accept only the exact staged or published
path, VHDX format, a non-differencing disk without a parent, and a positive
virtual size. Dynamic and fixed VHDX types are supported; a fixed VHDX file
may include format metadata beyond its virtual size. It MUST derive generation from the staged image's GPT or MBR
partition style, as today, without imposing a catalog generation on an
imported image. It MUST mount only a newly staged owner-private file, read-only
and without a drive letter, through typed `Mount-VHD`. It MUST use typed
`Dismount-VHD` and confirm detachment before publishing the base image or its
existing version-3 manifest.

Hashing, file copy, Storage partition inspection, locking, path containment,
manifests, and public response mapping remain Device Lab responsibilities.
The public MCP and CLI parameters, response shape, profile behavior, and
manifest schema MUST remain compatible.

## Failure and cleanup

A mount request may take effect even if its response is lost or malformed.
After any attempted mount, preparation MUST attempt bounded dismount of only
its transaction-owned staged path and confirm the image is detached. If this
cannot be confirmed, it MUST withhold the base and manifest, retain the staged
file for guarded recovery, and return a bounded redacted failure. It MUST NOT
blindly dismount a pre-existing base or delete an image that may be mounted.

Copy, hash, metadata, partition-style, deadline, and publish failures MUST
remove only files created by the current attempt. They MUST NOT overwrite or
remove a pre-existing base or valid manifest. The existing 409 profile
conflict, 422 preparation failure, bounded diagnostic detail, and
`--source-image` remedy MUST remain actionable without exposing host paths,
provider input, or raw native output.

## Verification

Tests MUST exercise new and reused imports through actual Windows and Linux
broker routing, exact typed VHD operation order, GPT and MBR, invalid VHD
metadata, unsupported partition style, hash mismatch, mount response loss,
dismount/readback failure, deadline cleanup, pre-existing image preservation,
and manifest absence after an uncertain outcome. Package and static contract
tests MUST cover the trusted PowerShell asset. Linux tests cannot establish
native Windows Hyper-V behavior; Windows-host mount lifecycle proof remains a
separate Goal requirement.
