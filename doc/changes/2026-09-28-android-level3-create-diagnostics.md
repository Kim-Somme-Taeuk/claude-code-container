# Android Level 3 creation failure diagnostics

The Windows Level 3 failure `device_create returned no device: provider-command-failed`
comes from the Android emulator destructive scenario. Its broker-backed creation
executes `avdmanager create avd`; the separately reported Hyper-V scenarios passed.
The broker already returns bounded command failure output in `detail`, but the
Android real-test assertion discarded it. The assertion now includes that field,
while preserving successful device extraction and existing launch diagnostics.
Regression coverage lives in `src/__tests__/test-level-runner.test.ts`.

The saved report cannot reveal the underlying Windows provisioning cause because
that detail was discarded. The initial assertion change improved diagnosis but
did not by itself establish successful provisioning. The targeted Windows run
documented below now passes. To reproduce that scenario from Windows PowerShell:

```powershell
$env:CCC_TEST_LEVEL = '3'
node --import tsx scripts/real-tests/run.ts scripts/real-tests/level3-real-destructive.ts
```

This invokes the same disposable Android scenario, including destructive controls
if creation succeeds. macOS is skipped on Windows. Capture the expanded failure
before changing SDK images, Java, or emulator configuration if a failure recurs.
A full Level 3 rerun is still needed to establish overall suite success.

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
the cause of its earlier `device_create` failure. The later targeted Windows
verification below passed; complete Level 3 verification remains outstanding.

Subsequent full broker-mediated runs reproduced an additional stop race: ADB
acknowledged the kill command before the owned serial disappeared, so immediate
guarded deletion failed. The host now confirms serial absence and an inactive
owned AVD process within one 30-second deadline before reporting stopped.
Unknown or late observations fail without confirming stopped metadata; deletion
guards remain unchanged. Host and MCP require
`android-emulator-stop-completion-v1`. See
[the stop requirement](../device-lab/REQ__android-stop-completion.md).

A later run passed installation, app lifecycle, network changes and recording,
then failed mobile clipboard setup because the broker-owned Appium process had
exited. Its startup output was discarded, so that exit cause remains unproven.
All three diagnostic AVDs were subsequently stopped and removed through guarded
APIs. The later Windows run below verified broker reload and the stop-completion
change live; complete Level 3 success remains unverified.

For this investigation, the temporary helper
`results/.tmp/ccc-windows-level3-diagnose.mts` collects broker refresh output,
Windows image selection, Appium version and bounded loopback startup output,
then runs that same level-3 scenario. Run it with `node --import tsx` from
Windows; results are retained locally in `results/windows-level3-diagnostic.json`.
The helper sets level 3 explicitly. A healthy diagnostic Appium server is
stopped after 15 seconds, so that diagnostic's timeout alone is not a failure.
This temporary helper is not a committed package entry point.

## Windows verification after broker refresh

The Windows diagnostic completed at `2026-09-28T15:14:13.341Z` with exit 0
for the complete Android destructive scenario. Automatic SDK discovery selected
`system-images;android-37.1;google_apis_playstore_ps16k;x86_64` (one installed
image). Broker PID 52636 advertised `android-emulator-stop-completion-v1`.
Appium 3.5.2 started successfully, and the Android scenario passed through its
clipboard, stop and guarded AVD deletion checks. macOS was skipped because the
host is Windows. The diagnostic Appium timeout was its deliberate 15-second
shutdown, not a startup failure.

This clears the targeted Windows reproduction and verifies the new stop path
in that scenario. The original generic creation error and earlier intermittent
installation/Appium exits have no established historical cause; they did not
recur in this Windows run. A fresh `npm run test:level3` result is still required
to claim success for the entire suite.
