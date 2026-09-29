# Minimal Device Lab output

## Inputs with one supported backend

Discovery omits `backend` for container-QEMU image list/import, target list,
readiness probe, session open, workspace sync, artifact export, guest-agent
status/provision, and macOS base-image create/clone. The server supplies their
sole backend only when the normalized argument is omitted. Compatible explicit
backend arguments remain accepted; contradictory or malformed values fail before
provider execution. These QEMU operations do not select host Hyper-V guests.
Defaults are applied after flow target inheritance and do not broaden ownership.

Creation advertises typed inputs instead of a generic `options` wrapper. Existing
wrappers still work, with top-level values taking precedence. Descriptions identify
platform-specific alternatives without implying unsupported defaults or key syntax.
The real-provider test runner validates the same effective arguments as the server.

Default MCP responses contain actionable state and operation results, without
repeated transport traces, owner storage paths, protocol capability versions or
duplicate status representations. Discovery returns one authoritative backend
list. Capability arrays are available through detailed output; normal discovery
shows availability and missing prerequisites. Device identities, incarnation IDs, unknown/unavailable state, lease
problems, operation outcomes and returned artifact paths remain usable.

Projection happens only at the public MCP response boundary. Internal provider
and broker contracts are unchanged. Opaque command output, UI trees, arbitrary
RPC values, images and resources are not filtered by metadata-like key names.
Flows retain per-step outcomes and apply the same presentation to known tool
results. Failures retain their cause, actionable recovery information and
partial cleanup/containment outcomes. Unknown shapes are preserved.

MCP callers can request `detail: true` for the original diagnostic response.
Default JSON text is serialized without indentation. Broker CLI status shows
verified readiness and endpoint; `--verbose` retains the original diagnostic
fields for attestation and troubleshooting. Unverified status never claims ready.
Status retains its existing broker repair behavior and does not start devices.

Diagnostic provider/routing tests explicitly request detailed output. Public
presentation tests must request compact output or use a client with no diagnostic
defaults, so compatibility coverage cannot hide a broken default response.

## Final VM and flow presentation

Known QEMU responses omit generated storage wiring and repeated successful
history from default output. Current readiness, target/session identity, usable
artifact paths and unique failure or recovery evidence remain. Sandbox and
macOS inventory retain prerequisites, provider identities and singleton/lock
evidence while removing executable wiring and exact discovery duplicates.
Detailed output retains the provider payload; presentation never changes state.

Flows return requested images and other native content after their leading JSON
summary, in step order, with a zero-based `contentIndex` and `contentCount` range into the outer content
array for each step containing native blocks. Index 0 is the JSON summary. Each returned
occurrence remains present, including repeated images and observations preceding
a failure. Failed flows set MCP `isError:true`. The 64 KiB failed-flow limit
applies to JSON text, not native attachments; bounding preserves their references.
General JSON replies mark explicit outer `ok:false` as an MCP error, without
inferring failure from arbitrary error fields or nested command/RPC data.

## Known ceiling

Known ceiling: Unknown envelopes remain unfiltered — add explicit projections when new provider response shapes require compaction.

Known ceiling: Semantic readiness-history deduplication recognizes process-only diagnostics; guest/custom diagnostics remain intact — upgrade when their producer-specific diagnostic preservation rules are explicitly covered.

Verification covers default and detailed responses, nested failures, fenced
action identifiers, opaque data preservation, flow results, unavailable brokers,
CLI exit status, and fresh source and bundled MCP server responses.

## Broker call flow

A tool operation reuses successful broker preparation and owner resolution
within that operation. Reuse is private, scoped to the same route, launch
options and owner context, and discarded on failure. Each public invocation,
including concurrent calls, and each flow step gets a fresh scope.

Each authenticated RPC still checks the live broker generation and reads its
owner credential. Device inventory and backend mismatch checks remain current;
no device result, credential or authorization is cached across operations.
Caller-supplied arguments cannot provide trusted preparation evidence.

## Every tool and provider

The compact contract applies to every advertised tool, including current-display
and VM management tools. Known successful helper envelopes must not repeat UI
hierarchies, input text, parsed response JSON or empty command diagnostics.
Opaque command output, image data, semantic UI content, current incarnation IDs,
artifact paths and unique failure/containment evidence remain available.
`detail: true` preserves the original diagnostic payload.

Advertised inputs describe the requested action and target. Internal mobile
connection settings need not be repeated in every tool schema; legacy callers
may still provide them. Destructive confirmation and input constraints remain.

Provider discovery and status formatting may share a fresh snapshot within one
list operation. They must not share snapshots across requests or replace fresh
mutation-time identity, generation and lease checks. State mutation may skip a
byte-identical write only after locking, reading and validating the result.

The exhaustive audit records every advertised tool and implementation function,
its disposition and supporting evidence. Static review and fixture tests are
reported separately from actual platform/device execution.

## Mobile waits and compact recording status

Android text/app waits use one monotonic polling budget after prerequisite and
ownership checks. Every UI dump, read, fallback and process query uses only the
remaining budget (at most the normal command timeout), and sleep cannot exceed
it. Zero/negative numeric timeouts normalize to one millisecond; nonfinite or
nonnumeric values use the default; upper bounds follow the advertised schema.
Standalone UI dumps and lifecycle boot waits keep their own existing behavior.

A failed final observation is an MCP error, not proof that the text/app is absent.
A later successful observation clears an earlier error. An empty, clean pidof
exit 1 means the app is absent. Successful no-match responses remain ordinary
results. Physical Android clipboard reads return the same exact `text` contract
as emulator clipboard reads, including empty strings and newlines.

Compact recording results keep active/finalizing state, recording/session IDs,
artifact paths, start/stop times and unique warnings or recovery data. Generated
host process identity and ownership metadata remain internal or in detail mode.
Only exact helper echoes are deduplicated. Session status keeps availability,
missing prerequisites and session identity while hiding executable discovery and
process metadata. No provider state is changed by presentation.

## Catalog, input and flow efficiency

Direct and detailed local backend catalogs share executable discovery only within
that catalog call. Emulator/simulator and physical-device prerequisites keep their
existing meanings. Default broker discovery remains lazy; later calls observe
new executable availability.

Missing or invalid mobile key/text-wait arguments fail before target or broker
preparation, including inside flows. Zero key codes and whitespace text remain
valid. Advertised schemas require an action value, and legacy nested options are
normalized before validation.

Default flow output is projected before failed-response size limits, so a large
successful observation cannot erase a later failure's identity and cause.
Detailed flow output remains original while it fits. Oversized failed flows keep
step identities and outcomes, explicitly mark omitted successful content and
bounded failure diagnostics, and retain actionable failure/recovery evidence.
The final serialized UTF-8 failure response stays within 64 KiB. This does not
change standalone opaque command/UI results or other diagnostic size limits.

## Intuitive tool selection and verification flows

Tool descriptions distinguish owned-device listing, backend prerequisites, and
single-backend inventory; recorded status does not promise universal live
readiness. Creation, startup and physical attachment remain separate actions.
Boot-wait guidance must match boolean polarity and platform-dependent defaults.
Flow arguments remain fixed, with no previous-result interpolation. Requested
screenshots are native image blocks in the same response, so inspection requires
no follow-up screenshot call. The canonical catalog contract below defines the
consolidated tool identities.

Within either flow, an explicit unmet condition from mobile_wait_for_text
(found:false) or mobile_wait_for_app (found:false or running:false) is a failed
step with error wait-condition-not-met. Default stopOnError prevents subsequent
actions; false continues while the flow remains unsuccessful. Original wait
observations and provider errors remain available. Successful waits, standalone
observational responses and unrelated tools' false fields retain their semantics.

## iOS Simulator app observation failures

An app wait distinguishes clean absence from inability to query the simulator.
A positive pgrep/launchctl observation retains success. Each polling sweep starts
with fresh observation trust: a clean observation in the final sweep permits
running:false, even if another fallback is unavailable. A clean pgrep exit 1
requires empty stdout/stderr; exit 0 without an error or signal is a valid query.
If the final sweep has no trustworthy observation, the public tool returns a
bounded MCP error retaining the command failure cause, not running:false. Earlier
clean observations cannot hide later total query failure. Existing fallback order,
ownership checks, and clean-absence response shape remain unchanged.

## Device lookup diagnostics

When no provider handles a registered tool requiring deviceId, the terminal
diagnostic distinguishes omitted IDs (missing-device-id), absent owner-local
devices (device-not-found), and unsupported operations on known targets
(device-tool-unsupported). Missing/absent targets give a short device_list hint.
Truly unknown tool names retain Unknown tool. Invalid IDs, provider/broker
errors, backend mismatch, policy refusals and successful results keep precedence.
Diagnostic lookup must not query providers or other owners, mutate state, mask
corrupt state as absence, or add lookup work to successful calls. Local QEMU
targets and the current display remain recognizable; ambiguous IDs are not guessed.

## Image and inventory metadata

Successful Linux VM image list/import responses omit owner IDs and generated
image timestamps. Recognized container-qemu image records retain identity, format,
size, copied state, artifact/source paths and unique diagnostic fields. Unknown or
failed image records and failed envelopes remain intact, including in mixed lists.
Empty lists still omit envelope ownership. Inventory applies the same compact
provider-plan presentation as list/status, both directly and within backend
entries. Failed plans, unavailable reasons and unique warnings remain; creation
and dry-run plans stay reviewable. Detailed responses remain original.

## Canonical tools and shared flow target

Advertise canonical device install/launch/screenshot, explicit mobile orientation,
and one device_run_flow. The six legacy mobile aliases (install_app, launch_app,
screenshot, rotate_left, rotate_right, run_flow) remain callable through their
original routes but are omitted from tools/list. Accepted-tool diagnostics and
projection still cover those names; detailed raw capabilities may include them.
The canonical catalog must shrink from its 57,211-byte starting size.

The canonical flow schema enumerates supported visible step tools, including
mobile app/system actions and canonical app install/launch. Existing allowed
legacy screenshot/rotation steps remain accepted. Device lifecycle, arbitrary
commands, broker management and nested flows remain disallowed. Every destructive
step requires its own confirmation. Empty flows and malformed step arguments fail.
Legacy mobile flows and step.name remain accepted; the advertised step field is tool.

Optional flow-level deviceId/backend/incarnationId apply only to device-targeted
steps. Normalize legacy nested step options first. If an explicit step deviceId
or backend differs from a provided default, inherit none of the target group.
Otherwise fill only omitted target fields supported by that step tool (mobile
actions do not receive an inherited incarnationId). Explicit invalid values still fail
validation. Never inherit confirmation, credentials, force or routing controls.
Target-neutral display/inventory steps receive no defaults. Each step retains
fresh broker/ownership checks, stopping semantics and compact/detail output.

## Mobile observation deadlines

Mobile text/app waits use one observation allowance after device discovery and
initial Appium session setup. The default is 10 seconds; finite numeric timeouts
are clamped to 1–600000 ms and poll intervals to 1–60000 ms (default 500). Each
subprocess, HTTP phase and controllable observation lock consumes the remaining
allowance; pauses cannot extend it or start another observation afterward.
Timeouts and incomplete output cannot supply a match or evidence of absence.
A completed clean non-match may establish absence, including a valid simulator
observation in the latest fallback sweep; without such evidence, failed
observation remains an error. Lost ownership always fails. Physical attachment
and broker identity checks remain.

This bounds observation work, not installation/session bootstrap or exact wall
clock completion: bounded process inspection, filesystem work, termination and
scheduling can add overhead. Matching client and host broker builds are required
for the underlying host request cancellation guarantee; older hosts retain their
previous internal request limits. Ordinary non-wait Appium requests retain their
existing timeout defaults.
