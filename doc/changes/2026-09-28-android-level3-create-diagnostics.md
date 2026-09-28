# Android Level 3 creation failure diagnostics

The Windows Level 3 failure `device_create returned no device: provider-command-failed`
comes from the Android emulator destructive scenario. Its broker-backed creation
executes `avdmanager create avd`; the separately reported Hyper-V scenarios passed.
The broker already returns bounded command failure output in `detail`, but the
Android real-test assertion discarded it. The assertion now includes that field,
while preserving successful device extraction and existing launch diagnostics.
Regression coverage lives in `src/__tests__/test-level-runner.test.ts`.

The saved report cannot reveal the underlying Windows provisioning cause because
that detail was discarded. This change improves diagnosis; it does not establish
that provisioning is fixed. With the updated checkout and the already built MCP
bundle, rerun only the destructive provider scenario from Windows PowerShell:

```powershell
node --import tsx scripts/real-tests/run.ts scripts/real-tests/level3-real-destructive.ts
```

This invokes the same disposable Android scenario, including destructive controls
if creation succeeds. macOS is skipped on Windows. Capture the expanded failure
before changing SDK images, Java, or emulator configuration. A full Level 3 rerun
is still needed to establish overall success after the provider cause is fixed.

The accompanying Harness maintenance sets manifest version 7 and ignores
`.claude/worktrees/`. The legacy `.version` marker was already absent/untracked;
no tracked operational files matched the effective Harness ignores.

## Continued scenario investigation

The destructive Android scenario now tracks successful creation from the
verified returned device identity rather than requiring a top-level `ok` field,
which normalized success responses omit. Later failures therefore still trigger
fixture cleanup. Cleanup validates stop, recording-stop and deletion responses,
attempts remaining cleanup after errors, and preserves the primary failure.
Structured `ok: false` responses are rejected with bounded provider diagnostics.
See [the cleanup requirement](../verification/REQ__android-e2e-cleanup.md).

A full broker-mediated Android run with an explicitly supplied installed image
passed creation and boot, then failed its app-install result assertion. A direct
retry of app installation succeeded; that first install failure is not yet
explained. Its fixture was stopped and deleted through normal guarded APIs.
This evidence does not establish the original Windows auto-selected image or
the cause of its earlier `device_create` failure. Windows targeted and complete
Level 3 verification remain required.
