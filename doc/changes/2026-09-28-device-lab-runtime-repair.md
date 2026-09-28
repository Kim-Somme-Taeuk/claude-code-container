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

## Continued Android cleanup investigation

The cleanup blocker was reproduced without changing the running emulator.
Its host console returns a valid AVD name, but the normal ADB console query
succeeds with empty output when the console has no authentication handshake.
The shared identity lookup now retries this specific successful-empty response
once with two fixed read-only name queries. A real ADB invocation recovered the
same name observed directly from the console. Both the broker and direct
provider use this lookup; malformed, conflicting, failed and still-empty
responses remain failures, and all ownership and process liveness checks remain.
See [the identity requirement](../device-lab/REQ__android-avd-identity.md).

The host and MCP require `android-avd-console-identity-v1`, allowing host CCC's
existing verified replacement path to replace an older same-version broker.
Updating files does not reload the currently running Windows broker.

## Known ceiling

The original Windows Level 3 failure is not proven resolved: the supplied
output omitted the provider diagnostic, and that full suite was not rerun on
the Windows host. The previous diagnostic fix exposes provider details on the
next run. The guessed Android 36 package was rejected; the installed Android
37.1 package succeeded. This does not establish the original failure's cause.

The Windows broker was replaced through `node .\dist\index.js devices broker status`
and advertised `android-avd-console-identity-v1`. A fresh built MCP then deleted
the stopped task-owned `ccc-runtime-repair-0928` AVD through the normal guarded
API with explicit destructive confirmation. The response reported `avdDeleted: true`;
subsequent inventory excluded the fixture and retained all other registered
devices. The old broker's empty-name cleanup blocker is therefore resolved in
this live case. No existing user emulator was stopped.

A running MCP process retains its loaded code. Reopening CCC after installing
the updated host package applies generated configuration and starts the updated
MCP process; successful fresh-process verification is not a claim that the old
process reloaded. The Windows PowerShell parser check is unavailable on this
Linux host; the build reports that check as skipped.
