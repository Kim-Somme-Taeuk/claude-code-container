# Device Lab connection and Codex sandbox prerequisites

Device Lab now finds the isolated owner credential even when the MCP launcher
filters its environment, and reports RPC readiness only when that credential
validates. Managed MCP configurations explicitly supply the mount path. Backend
discovery and implicit Hyper-V selection have a separate 30-second RPC budget
instead of inheriting the short health probe timeout. CCC images include
bubblewrap; preparing Codex in an older container installs it if missing and
verifies the executable as the normal user, without changing sandbox settings.

## Runtime evidence

The rebuilt MCP bundle discovered the Windows host backends and read inventory
with `CCC_DEVICE_BROKER_AUTH_FILE` omitted. An actual disposable Android AVD
using the host's installed `system-images;android-37.1;google_apis_playstore_ps16k;x86_64`
package was created, booted (`sys.boot_completed=1`), queried, and stopped.
The current container also ran a user/PID namespace command through distro
bubblewrap 0.9.0. Focused regressions cover credential precedence, invalid
credentials failing closed, delayed discovery, explicit RPC timeout overrides,
and existing-container dependency installation and failures.

## Known ceiling

The original Windows Level 3 failure is not proven resolved: the supplied
output omitted the provider diagnostic, and that full suite was not rerun on
the Windows host. The previous diagnostic fix exposes provider details on the
next run. The guessed Android 36 package was rejected; the installed Android
37.1 package succeeded. This does not establish the original failure's cause.

Cleanup of the stopped task-owned `ccc-runtime-repair-0928` AVD was refused by
the host's liveness guard because a different emulator (`emulator-5638`) returned
no AVD name. The guard was retained and no existing user emulator was stopped.
The fixture remains stopped until that identity can be verified and normal
`device_delete` with `deleteAvd: true` succeeds.

A running MCP process retains its loaded code. Reopening CCC after installing
the updated host package applies generated configuration and starts the updated
MCP process; successful fresh-process verification is not a claim that the old
process reloaded. The Windows PowerShell parser check is unavailable on this
Linux host; the build reports that check as skipped.
