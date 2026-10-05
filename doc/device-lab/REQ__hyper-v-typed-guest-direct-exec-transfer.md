---
area: device-lab
slug: hyper-v-typed-guest-direct-exec-transfer
status: current
---

# REQ — Typed Windows guest execution and transfer

## Production routes

An actual Windows VM `device_exec`, `device_upload`, or `device_download` request
MUST execute its PowerShell Direct target through the typed Hyper-V Windows
library. Device Lab MUST continue to resolve the device inside the caller's
owner state, verify the exact VM ID/name/Notes and owner-private credential
path, stage host files under the owner-private root, and preserve the existing
MCP response shape and provider label. Dry-run and Linux SSH routes are outside
this requirement.

## Credential and primitive boundary

The low-level library MUST validate exact request and response schemas, a
bounded command, absolute paths, transfer limits, and one VM selector. A guest
action MUST run once, with no implicit retry. It MAY resolve the VM and create
and remove a PowerShell Direct session around that one target action. It MUST
check the expected VM identity and Running state before opening the session,
import the path-bound CLIXML credential as a PSCredential, and dispose the
session on every outcome. Credentials and guest command text MUST NOT appear in
errors, logs, or public diagnostics. Credential-bearing operations MUST use an
isolated one-shot PowerShell transport and MUST NOT enter the process-wide
shared session pool.

The low-level layer MUST remain independent of Device Lab roots, CCC owner
markers, HTTP errors, and file staging policy. Its generic expected VM name and
Notes are target preconditions supplied by the Device Lab adapter.

## Transfers and output

Guest exec MUST retain the bounded UTF-16LE encoded-command behavior and
report the guest process exit code with bounded stdout and stderr. A nonzero
guest exit remains a completed transport call and maps to the existing public
HTTP 422 guest-command failure. Upload MUST create the remote parent before a
separate typed Copy-Item target, then report source and destination paths and
bytes. Download MUST reject a missing, changed, or over-limit guest file and
write only to the broker's owner-private staging path. The broker MUST check
the staged byte count and path safety before publishing the requested local
file. The existing 16 MiB download limit and upload staging limit remain.

Publishing a new file below a nested workspace directory requires the exact
destination file to exist before `device_download`. This preserves the broker's
verified-descriptor rule: it does not create a new leaf through a nested parent
that could be replaced between validation and open. Root-level destinations may
still be created directly, and existing nested regular files are opened with
the existing no-follow and descriptor/path identity checks. The disposable
Windows E2E therefore precreates its exact round-trip and packaged-evidence
destination files; it does not weaken the broker rule. Destination preparation
keeps the leaf open, compares descriptor and path identity, and truncates that
verified descriptor. Before opening and again before truncating, it validates
every parent component against the trusted repository root, rejecting directory
symlinks and Windows junctions. It never unlinks a pathname after validation
failure. This also resets an existing `latest` evidence file so a failed current
download cannot leave prior evidence looking current.

A missing credential, mismatched VM, malformed envelope, timeout, or lost
response MUST fail closed with a bounded 502 or existing validation/conflict
response as appropriate. The broker MUST remove only its owned staging files
on failure. It MUST NOT infer success from a remote file after an uncertain
copy outcome, and MUST NOT replay that copy automatically.

## Verification

Tests MUST cover exact one-call target operation counts, VM identity and
credential validation, session cleanup, command nonzero status, upload ordering,
download byte/size disagreement, lost response, timeout, staging cleanup,
new nested destination refusal, E2E destination preparation, public redaction,
and package/static asset wiring. Linux simulation cannot
prove native Windows PowerShell Direct behavior; the parent Goal retains that
host proof gate.
