# Minimal Device Lab responses

MCP now returns compact JSON with one backend list, concise broker status and
device results without duplicated state, transport echoes or internal path and
process metadata. Capability arrays and full diagnostics are available with
`detail: true`. Broker CLI status reports readiness and endpoint; `--verbose`
retains attestation fields, and internal diagnostic callers request it explicitly.
The projection runs only at the final MCP boundary, preserving internal broker
contracts, incarnation IDs, command/UI content, images and actionable failures.
See [the output contract](../device-lab/REQ__minimal-output.md).

Read-only source MCP measurements on this host (serialized reply bytes): broker
status 16,562 to 167; backend discovery 58,732 to 1,545; device list 9,808 to 1,617;
inventory 2,264 to 729. Sizes depend on device state and do not imply the same
percentage reduction in tokenizer counts.

Known ceiling: Unknown envelopes remain unfiltered — add explicit projections when new provider response shapes require compaction.
