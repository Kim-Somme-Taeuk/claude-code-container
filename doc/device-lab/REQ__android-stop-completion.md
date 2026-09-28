# Android emulator stop completion

The host broker must not report a successful emulator stop merely because ADB
acknowledged the kill command. Before persisting stopped state or clearing
runtime metadata, it must observe both the owned serial absent from a successful
ADB inventory and the owned AVD process inactive. An unrelated unavailable
emulator must not prevent confirming this target's stop.

All observations share a bounded deadline and each subprocess receives no more
than the remaining time. Failed observations and deadline exhaustion are errors,
not proof of exit; leave stop metadata unconfirmed and report a bounded reason.
Do not repeat the kill command. Preserve owner-operation serialization, process
identity checks and all existing guarded deletion requirements.

Advertise and require the updated stop capability on host and MCP so host CCC
can replace an older same-version broker through its verified update path.

Verify delayed serial/process disappearance, each observation independently
required, failed observation, deadline exhaustion, an unrelated offline emulator,
and successful stop followed immediately by ordinary guarded fixture deletion.
