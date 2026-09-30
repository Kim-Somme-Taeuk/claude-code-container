# Preparation-free public tools

Existing-device calls use an explicit deviceId and resolve its provider. No shared
selected device or preliminary session-opening call is required.

Public create provisions Android when systemImage is supplied (avdName may name
the new owned AVD), and reuses an existing AVD when avdName is supplied alone.
iOS provisions unless an existing udid is explicitly supplied. Creation flags are
private implementation details. Missing or conflicting creation inputs produce an
actionable error before provider dispatch. Provider failures retain existing
cleanup behavior; creation does not silently download SDK images. Backend-specific
flat input branches describe relevant configuration and reject mismatched fields.

workspace_sync and artifacts_export are private staging operations, not public
device file transfers. upload/download perform their own bounded preparation.
clear_app_data clears the selected app; reset erases an iOS Simulator. Both retain
destructive confirmation and existing ownership validation. reset accepts no app
identifier and cannot silently become an app-only reset.

Public helperTimeoutMs is removed. Caller-adjustable operation deadlines use
timeoutMs, translated to bounded provider controls. Existing default boot, install
and containment budgets remain intact; no timeout disables containment.

The catalog remains independent of a shared active device. Missing prerequisites,
stopped devices and broker outages must not hide setup or recovery operations.
Catalog reduction cannot rely on pagination being lazily loaded by MCP clients.
Verify public schema and routing together, including removed arguments, destructive
failures, creation/reuse and upload without a separate staging call.
