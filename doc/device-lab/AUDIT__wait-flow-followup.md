# Wait and response optimization follow-up

Baseline: `56a88ecd`. This supplements the [93-tool baseline audit](AUDIT__tool-optimization.md); the historical 1,393-node inventory is unchanged.

| Tool/path | Finding | Change | Preserved |
| --- | --- | --- | --- |
| Android `mobile_wait_for_text`, both backends | Each dump/read/fallback could take 120 seconds independently; errors became found:false | One monotonic remaining budget per poll sequence, no exhausted-budget fallback; final failed observation is MCP error | Full source on successful detailed response, shell-cat fallback, prerequisite/owner checks |
| Android `mobile_wait_for_app`, both backends | Command timeout and final sleep exceeded polling budget; transport failure looked like absence | Remaining command/sleep budget; clean empty pidof exit 1 means absence, other failures stay errors | PID and clean successful nonmatch semantics |
| Physical Android `mobile_get_clipboard` | Missing required text field | Exact clipboard text in the standard field | Unicode, empty text, whitespace, existing lease checks and command failures |
| Recording start/stop/status and target status | Generated process metadata and exact helper mirrors repeated | Remove explicit internal process fields and exact helper echoes at public boundary | Recording identity, finalization, artifacts, times, unique warnings and nested errors |
| `mobile_session_status`, `device_status` Appium block | Nested runtime/process/executable fields remained verbose | Known automation-status projection | Session identity, availability, missing prerequisites, remedies and failure evidence |
| `device_backends` current display | File-based X11 availability checked twice | Derive availability and capabilities from one fresh display target | New observation on next call, container Linux backend and host precedence |

The new `android-wait.mjs` helper centralizes only the duplicated Android text/app
polling policy: bounded numeric inputs, failure detection, monotonic deadline,
per-command remaining budget and bounded sleep. It does not cache provider
results or take over lifecycle/session/lease responsibilities. Existing standalone
UI dump helpers intentionally retain their timeout contract. All modified handler
branches, helper functions and presentation callbacks are included in independent
review; tests exercise both providers through their real public handlers.

Polling budget excludes initial discovery and ownership checks. Operating-system
process startup/termination and timer scheduling can add overhead; this does not
claim an end-to-end hard real-time deadline. Native devices/platforms need their
own real-host validation. No destructive provider scenario is part of this audit.

## Continued call and flow audit (baseline `0180c67d`)

The four local mobile backend descriptors performed nine executable lookups:
adb/emulator/avdmanager twice, xcrun twice, and xcodebuild once. Their existing
discovery inputs permit one fresh snapshot per catalog, reducing those lookups
to five. This concerns direct/detailed local discovery; default broker discovery
already skips those providers. Provider prerequisite meanings must stay unchanged.

`mobile_key` accepted a schema with neither key nor keyCode, and an invalid broker
text wait could reach Appium session preparation. Shared dispatch preflight and
the advertised schemas must reject missing action values before that work while
preserving zero key codes, whitespace text and legacy nested arguments.

A failed flow with a 70,000-character successful wait source was summarized as
`diagnostic-response-too-large` before compact presentation could discard the
source. Both step outcomes and the real later failure were lost. Projecting that
same fixture first produced 325 bytes retaining the error. Flow serialization
must project first and preserve bounded step/failure evidence on genuine overflow.

Retained boundaries: implicit inventory resolves routing and backend mismatches;
host execution rechecks ownership. Broker generation attestation, credentials,
physical leases and fresh per-step operation scopes remain necessary.

## Known ceiling

The independent broker-Appium request/attestation budgets identified at this
baseline are addressed by the observation-budget work below. Older host broker
builds still use the previous internal request limits.

On an oversized failed flow, successful text/JSON content is explicitly omitted
before failure diagnostics are shortened. If unusually many content blocks cannot
fit even as individual markers, the response keeps every step outcome and a
bounded diagnostic excerpt with the original content count and byte size.

## Intuitive tool flow follow-up (baseline `9b1db42b`)

The catalog distinguishes owned device IDs from prerequisites and one-backend
inventory, and recorded status from an active readiness probe. Boot-wait guidance
now describes the actual boolean meaning without claiming a universal default.
Direct Android/iOS start defaults to waiting; direct macOS differs. Missing Appium
session metadata does not by itself make direct Android ADB actions unavailable.

Flow arguments are literal; previous results are not interpolated. Flow screenshots now return native images in the same response, with per-step
content references; the former standalone follow-up call is unnecessary. An explicit unmet text/app wait now fails its verification step and stops
later actions by default. With stopOnError:false, later steps run but the overall
flow stays unsuccessful. Standalone wait observations retain their current shape.

Remaining follow-ups: some direct unknown-device routes report Unknown tool even
for a known tool; iOS process-wait observation failures can be reported as absence.
Those need separate routing/provider fixes rather than misleading description changes.

## iOS app observation follow-up (baseline `7ca47947`)

Reproduced all simulator commands failing with exit 2 and a diagnostic while the
app wait returned running:false. A nonexistent xcrun executable also lost its
spawn error. The wait now keeps trustworthy observations per polling sweep and
uses the final sweep only: successful queries can establish absence; total query
failure becomes an MCP error retaining a bounded command cause. Existing pgrep
and launchctl fallbacks and ownership checks remain in place. A successful fallback
can still find the app when pgrep is unavailable.

The observation-budget follow-up below also bounds these simulator commands.
Known ceiling: Linux-host fixtures do not prove native macOS or physical iOS behavior.

## Device diagnostic follow-up (baseline `5560c9e2`)

A direct mobile_screenshot call with a nonexistent device ID returned
Unknown tool even though the tool was registered. Terminal fallback diagnostics
now distinguish a missing ID, an absent owner-local device, and an unsupported
operation on a known target. Existing provider and broker errors retain
precedence. Raw owner-state reads avoid querying device providers merely to explain
an error; container QEMU targets and the current display remain recognizable.
The user requested deletion of the standalone MCP UX handoff; durable behavior
and remaining wait-budget limitations stay in this audit and the REQ.

## Shared observation budget (baseline `2b2fc317`)

Android and direct iOS waits use a small monotonic budget primitive. Simulator
process fallbacks share the remaining allowance; direct Appium waits prepare the
session once and bound each observation request. Physical attachment/session
checks remain part of observation instead of disappearing with repeated setup.
Broker polls propagate an optional request allowance through owner resolution,
generation attestation and RPC; the host consumes its allocation through owner
and lease lock acquisition before the Appium fetch. Ordinary Appium requests
keep their existing timeout defaults. Exhaustion prevents later observations.

Known ceiling: the allowance starts after discovery and initial session setup.
Bounded identity inspection, filesystem work, process termination and event-loop
scheduling can add wall-clock overhead. Older broker builds cannot enforce the
new underlying host request allowance; deploy matching client/broker builds.
