# Android AVD identity during deletion

Deletion must establish that the owner-scoped AVD is inactive before removing
its artifacts. Every visible emulator must have a verified console AVD name;
offline, failed, empty or conflicting identity responses must block deletion.
Owner scope, approved storage roots and the host process liveness check remain
required independently of console lookup.

Some ADB console clients strip two `OK` replies assuming a greeting and an
authentication handshake. A console that requires no authentication can return
its name successfully while ADB discards the entire response. When the normal
read-only `avd name` query succeeds but yields only whitespace/`OK`, retry once
with the fixed literal `avd name\navd name` console command. Accept only legal,
identical names from this retry. Use the existing bounded command execution;
do not retry failed commands, disable authentication, substitute guest property
values, or treat unknown identity as an inactive AVD. Both the host broker and
the direct provider must follow the same rule.

The host advertises `android-avd-console-identity-v1`. Host CCC and the MCP
require this capability so an older same-version broker cannot silently keep
the broken lookup after an update. Host CCC's existing verified replacement
path prepares the new broker; a container must not terminate a process it
cannot verify on the host.

Verify normal, empty-success, repeated identical, conflicting, error and
unavailable responses. An active target must still block deletion after the
compatibility retry; an unrelated identified emulator must not block deleting
a verified inactive owner-scoped target.

Observed on the Windows host and independently reproduced with ADB 34.0.4.
The [AOSP console client](https://android.googlesource.com/platform/system/core.git/+/979f3d0116ee62b1461c94899ad7d82d2c00cd3e/adb/client/console.cpp)
shows the two-response stripping behavior. Live console response and the ADB
single-query/double-query comparison establish the applicability here.
