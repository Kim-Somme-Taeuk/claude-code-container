# Device Lab flow and discovery efficiency

Local mobile backend catalogs share fresh discovery snapshots, reducing executable lookups from nine to five without caching between calls. Invalid key and text-wait inputs fail before provider preparation. Both flow tools compact successful observations before applying failure-response bounds, preserve step outcomes and actionable errors, and skip duplicate response compaction. Detailed responses retain raw content when within bounds. Malformed step labels and tool names cannot bypass the response budget. Regression coverage includes source MCP calls, continued failures, Unicode, and oversized diagnostics.

## Known ceiling

Oversized failed flows explicitly omit successful text/JSON and bound failure evidence to 64 KiB; pathological content counts may become one diagnostic excerpt per step. Broker Appium polling still needs a separate end-to-end host deadline contract. Running MCP processes need a restart to load updated code; rebuilding files does not update an already-loaded server.
