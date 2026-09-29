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
