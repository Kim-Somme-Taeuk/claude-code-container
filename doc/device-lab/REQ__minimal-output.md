# Minimal Device Lab output

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

## Known ceiling

Known ceiling: Unknown envelopes remain unfiltered — add explicit projections when new provider response shapes require compaction.

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
Descriptions expose flow limitations: fixed arguments, no previous-result
interpolation, and image summaries; inspecting screenshots requires a standalone
screenshot call. These clarifications must not increase the serialized tool
catalog above the 57,496-byte baseline or change tool identities/schema constraints.

Within either flow, an explicit unmet condition from mobile_wait_for_text
(found:false) or mobile_wait_for_app (found:false or running:false) is a failed
step with error wait-condition-not-met. Default stopOnError prevents subsequent
actions; false continues while the flow remains unsuccessful. Original wait
observations and provider errors remain available. Successful waits, standalone
observational responses and unrelated tools' false fields retain their semantics.
