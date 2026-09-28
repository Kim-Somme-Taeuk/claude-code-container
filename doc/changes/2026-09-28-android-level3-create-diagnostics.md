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
