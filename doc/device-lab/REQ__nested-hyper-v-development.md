# Nested Hyper-V development VM

An explicitly requested Windows development VM can expose hardware virtualization
extensions to its guest. `create_windows_vm` accepts `nestedVirtualization:true`.
Creation configures the processor while the VM is stopped,
before its first boot. Nesting is off by default; only an explicit true enables
it. The dedicated development runner supplies true. This is not a global default
for Windows or other VMs. Unsupported hardware or
host settings fail creation through the existing cleanup path. Reusing an existing
ID with a different nesting setting must fail instead of silently reconfiguring it.

The development workflow retains this outer VM across runs. It prepares Hyper-V
inside the guest, handles the feature-install reboot, transfers a current source
snapshot, builds the candidate inside the guest and runs its own broker/MCP and
inner Hyper-V tests. Test execution must not reuse the physical host broker as the
candidate. A failed install/build/test is returned as a failure, with its stage and
logs. No VM, history or image outside this workflow is removed.

Source snapshots include tracked working-tree changes, not just the last commit.
Credentials, ignored files and installed dependencies are not included. Initial
host support for the nesting option requires a one-time host update; subsequent
candidate iterations use the retained guest. Windows image-license acceptance is
never fabricated by the runner. A readiness probe or simulated-provider test does
not count as an actual nested Hyper-V test pass.

The nested job must not require a fixed 80 GiB (Windows) or 40 GiB (Linux)
before building. Provider stages enforce capacity on their destination volume.
For Windows image download/publication, reserve the validated download
length plus 10 GiB; publication renames the staging file on the same volume. A verified
cached image needs no new download allocation. For a VM disk full copy, require
the opened source file length plus 10 GiB, not its virtual maximum capacity.
Virtual disk geometry, ownership and content verification remain independent
requirements. Passing these checks is not a reservation against concurrent disk
use or a guarantee against later dynamic disk growth.

The scheduled guest job runs as SYSTEM. Private image and VM directory ACLs must
use the unique SID set of the current identity, SYSTEM and Administrators. When
the current identity is SYSTEM, two principals are expected, not three duplicate
entries. Ownership, protected inheritance and exact permission checks remain
required; supporting SYSTEM must not grant access to additional principals.

Source enumeration must have a bounded execution time. Git failures retain a
constant classified reason and process status in the run diagnostics, without raw
Git output or host paths. Missing Git, a non-repository checkout and Git ownership
refusals remain failures; never bypass ownership checks or copy the entire
directory as a fallback.

## Checkout cleanup

Checkout refresh and successful-run cleanup must retain the stable checkout
directory and its ownership marker. Remove only owned source contents; reject
unmarked or redirected directories. Windows can keep a directory locked as a
process working directory after its files are released. This must not destroy
the ownership marker or force unrelated process termination. Legacy marker loss
requires separately verified recovery, not automatic adoption of an empty path.

Normal npm workspace directory links are permitted only at these exact checkout
paths, with a single target equal to the corresponding ordinary checkout directory:
`node_modules/@ccc/hyper-v` to `packages/hyper-v`,
`node_modules/@ccc/device-lab` to `packages/device-lab`, and
`node_modules/@ccc/device-lab-mcp` to `device-lab-mcp`. Validate the complete
actual tree and target ancestors without following links before deleting anything.
Unlink these recognized links nonrecursively, then freshly validate and enumerate
ordinary contents for cleanup. Reject every other reparse point or redirected
target; failures retain the stable root and ownership marker. A successful guest
test followed by failed cleanup remains an overall failed run.

## Elevated network transport

Launch the elevated child directly within the bounded PowerShell command budget,
without a gzip/decompression execution wrapper. Native nested diagnostics found
Defender terminating that wrapper as `PShellCobStager.A`, surfacing as a relay
protocol failure or handshake timeout. Do not disable protection or add antivirus
exclusions to run these tests. Authentication and command-size limits still apply.

The elevated network child must preserve its authenticated pipe reader when
handing input to the operation session. A bootstrap read can buffer bytes from
the following operation asset; replacing that reader discards those bytes and
can cause a protocol failure. Regression verification must exercise coalesced
frames through the generated PowerShell handoff, not only mocked relay events.
This transport check does not establish a complete nested Windows E2E pass.

## Live progress

The CLI reports stage changes and elapsed waiting time at least every 30 seconds
while asynchronous operations are pending. It includes the last observed guest
stage from an atomic run-identified progress record. Waiting output means the
runner is waiting, not proof the guest is making progress. Unknown or mismatched
records must not advance the run or imply success. Progress output excludes raw
commands, credentials and guest log contents; timers stop on success or failure.
Existing running jobs are not restarted to enable this output.
Progress-file replacement must work under Windows PowerShell 5.1 as well as
PowerShell 7. Use an explicitly null string for the optional `File.Replace`
backup path: Windows PowerShell binds `$null` to an invalid empty path here.
Exercise initial publication and repeated replacements using the actual helper.

## Shared broker protocol and concise failures

MCP, host CLI and integration preflight use a single integer `protocolVersion`, defined in `packages/device-lab/providers/contracts/broker-protocol.mjs`. Compatibility requires exact equality; missing, malformed, older and newer values fail closed. Package versions are informational. Per-feature version lists do not participate in compatibility or appear in status. Breaking changes and fixes requiring old processes to be replaced bump this one version. Device capability discovery still describes supported actions, not patch levels.

Broker replacement continues to require verified process identity. A newer protocol must never be automatically downgraded. On Windows the nested runner compiles the current checkout before running the existing host broker repair/attestation, before any VM operation. Errors print a bounded code and action, not RPC payloads, owner metadata or capability lists. A failed identity check remains a real failure and must not be hidden by changing compatibility rules.

Saved startup failures distinguish the host power command from the guest readiness
probe. A successful host exit status is not evidence that the guest is ready.
Retain bounded readiness reasons, attempts and typed diagnostic facts with their
source paths; omit raw probe output, command arguments and credentials. Matching
protocol versions do not prove a running broker has reloaded edited source files.
