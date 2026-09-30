# Device Lab MCP tool and function optimization audit

## Current canonical contract (2026-09-30)

Discovery and public dispatch now share one 59-tool unprefixed catalog. The historical
compatibility observations below are superseded: six mobile aliases and hidden
broker/image operations are no longer public MCP calls. Creation arguments are
flat, existing-device tools use deviceId without backend selectors, and flow steps require
`tool` rather than accepting `name`. Rejected legacy input performs no provider
work. Internal broker APIs are tested directly, without restoring public aliases.

The normal journey is device list, choose an ID, screenshot, interaction, then
observe. A flow can share the target once and return its final screenshot in the
same response. A new call is needed when the next action depends on seeing that
screen; flows do not make conditional decisions or interpolate prior results.
Common mobile/desktop actions share click, double_click, type and key; the
current display uses these same tools with deviceId. Move and cursor queries
are separate. Simple successful actions return ok, while queries retain useful
data/native images and errors/warnings retain actionable evidence.
The 76-tool intermediate catalog was reduced to 60 tools by grouping snapshot,
recording, permission and clipboard operations, sharing mobile/desktop `ui`, and
removing eight standalone preparation or diagnostic calls. Group actions resolve
before routing, policy and flow checks; recording start/stop remain disallowed in
flows. An empty clipboard string means write, while omitted text means read.

`list_files` added bounded directory browsing as the 61st tool. It takes a device
ID and path, infers the provider, and returns immediate names, types and available
file sizes. The iOS Simulator route stays inside a selected app container;
physical-iOS app file sharing is a platform capability without a Device Lab
listing adapter yet. See [file listing requirements](REQ__file-listing.md).

The preparation follow-up removes public `workspace_sync` and `artifacts_export`,
which operate on management storage rather than the guest. The resulting catalog
has 59 tools. Create now separates four common schema fields from backend-specific
branches and automatically provisions mobile resources from creation inputs.
`reset` exclusively erases iOS Simulator; `clear_app_data` targets an app. Public
operation deadlines use `timeoutMs`, with helper deadlines translated internally.
See [preparation-free requirements](REQ__preparation-free-tools.md).

`status` includes read-only automation diagnostics and live readiness for running
container QEMU guests. `backends` includes broker diagnostics. `start` prepares
disks and configured guest agents automatically; preparation failure preserves
the running VM and a repeated start retries preparation without launching another
process. Metadata-only session opening is no longer part of the public workflow.
Provider inference reads persisted iOS/macOS identities without running live
inventory queries. The chosen provider still checks the actual target before
operating; ordinary device-list queries retain live observations.

Serialized discovery schemas measure 40,312 bytes (40,726 before this preparation cleanup) versus 45,579 bytes for the
76-tool intermediate catalog and 56,825 bytes for the earlier 87-tool catalog
(JSON UTF-8 bytes, not model token counts).

Known ceiling: Internal transport controls remain available to existing route/test
machinery. Their distinct host-routing contracts are outside this public alias
removal; this change does not claim all internal transport options were removed.

Baseline: `997a7f63`. Reviewed 2026-09-29. Scope: all 93 advertised Device Lab tools and 1,393 JavaScript function-like nodes with bodies (including nested callbacks), plus five Windows helper PowerShell functions. [Exact per-function dispositions](AUDIT__function-optimization.json) refer to baseline line positions; changed-module named functions have a separate final review list. Counts measure source coverage, not real-device coverage.

## Implemented

Default presentation removes empty successful subprocess diagnostics, desktop helper/UI duplicates, typed-text echoes, cursor raw echoes, exact Linux lab/device aliases, and repeated wait UI source. IDs, incarnation, artifact paths, requested exec output, screenshots, UI dumps, unique warnings and failure/cleanup evidence remain. List/status provider plans omit execution internals; create/dry-run plans remain reviewable. Every tool retains optional detail:true. Internal provider and CLI contracts stay full.

Mobile schemas omit five implementation connection controls while runtime legacy arguments remain accepted. Backendless inventory explicitly describes its local Android default; device_list is the all-owned-device entry point. Default broker backend discovery probes container display/Linux backends; host-only local provider discovery runs only in direct mode or detail. Host broker entries retain name precedence.

Read-only lists share simulator inventory, macOS discovery and physical lease observations within one call. Mobile status siblings share discovery; iOS Appium ensure shares HTTP health observations while retaining session and ownership validation. Store writes are skipped only after locking and full input/output validation when serialized content is unchanged; initially absent files are still created.

## Retained deliberately

No authorization, generation, ownership, physical-lease or process-identity check is cached across calls. Mutating simulator identity is observed fresh. Wait loops retain per-poll checks within the shared observation allowance. VM histories retain unique observations, artifacts and recovery evidence; repeated successful process-only observations are compacted explicitly. External Appium server readiness does not imply ownership of its process.

## Every tool

Each row was reviewed for advertised inputs, routing/side effects, semantic success and failure. The exhaustive success/failure fixtures in src/__tests__/device-lab-all-tools-output.test.ts independently assert exact registry coverage. Provider-count, state, and wire tests cover changed execution paths. Required/anyOf alternatives and confirmation fields remain; legacy transport options are accepted but hidden. Failure policy for every row: preserve error flag, unique cause and cleanup/recovery evidence. Native image/resource blocks remain opaque.

| Tool | Required input | Success contract | Call/output disposition |
| --- | --- | --- | --- |
| device_backends | none | backend-catalog-v1 | Lazy host-only local discovery; container providers retained; truthful broker failures. |
| device_broker_status | none | broker-status-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_list | none | device-list-v1 | Compact identity/state, no repeated provider commands; read-only list snapshots only. |
| device_inventory | none | device-inventory-v1 | Explicit one-backend inventory; local Android default documented; no silent all-provider claim. |
| device_image_list | backend | vm-image-list-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_image_import | backend, name, sourcePath | vm-image-import-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_wireless | backend | wireless-status-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_current | none | display-target-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_screenshot | none | image-content-v1 | Preserve native image bytes and screenshot geometry/incarnation; no image-to-text duplication. |
| display_click | x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_double_click | x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_key | key | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_type | text | text-action-v1 | Acknowledge typing with length; do not echo entered text. |
| display_scroll | x, y, direction | scroll-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| display_cursor_position | none | cursor-position-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_create | backend, name | lifecycle-device-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_attach | backend | physical-attach-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_detach | deviceId | physical-detach-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_delete | deviceId | lifecycle-delete-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_start | deviceId | lifecycle-device-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_stop | deviceId | lifecycle-device-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_reboot | deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_status | deviceId | lifecycle-device-v1 | Compact identity/state, no repeated provider commands; read-only list snapshots only. |
| device_disk_materialize | deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_target_list | backend | vm-target-list-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_readiness_probe | backend, deviceId | vm-readiness-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_session_open | backend, deviceId | vm-session-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_workspace_sync | backend, deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_artifacts_export | backend, deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_guest_agent_status | backend, deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_guest_agent_provision | backend, deviceId | vm-operation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_exec | deviceId, command | command-execution-v1 | Opaque command result preserved exactly, including empty streams and exit status. |
| device_screenshot | deviceId | image-content-v1 | Preserve native image bytes and screenshot geometry/incarnation; no image-to-text duplication. |
| device_click | deviceId, x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_double_click | deviceId, x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_key | deviceId, key | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_type | deviceId, text | text-action-v1 | Acknowledge typing with length; do not echo entered text. |
| device_scroll | deviceId, direction | scroll-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_cursor_position | deviceId | cursor-position-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_window_list | deviceId | window-list-v1 | Emit semantic UI result once; retain unique helper warnings. |
| device_accessibility_snapshot | deviceId | accessibility-snapshot-v1 | Preserve snapshot identity, diskSnapshot:false and partial restore recovery; no added retries. |
| device_base_image_create | backend, name, sourceImage | base-image-device-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_base_image_clone | backend, name | base-image-device-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_snapshot_list | deviceId | snapshot-list-v1 | Preserve snapshot identity, diskSnapshot:false and partial restore recovery; no added retries. |
| device_snapshot_create | deviceId, snapshotName | snapshot-create-v1 | Preserve snapshot identity, diskSnapshot:false and partial restore recovery; no added retries. |
| device_snapshot_restore | deviceId | snapshot-restore-v1 | Preserve snapshot identity, diskSnapshot:false and partial restore recovery; no added retries. |
| device_snapshot_delete | deviceId | snapshot-delete-v1 | Preserve snapshot identity, diskSnapshot:false and partial restore recovery; no added retries. |
| device_record_video_start | deviceId | recording-start-v1 | Preserve recording/artifact state and partial finalization failures; no process-identity checks removed. |
| device_record_video_stop | deviceId | recording-stop-v1 | Preserve recording/artifact state and partial finalization failures; no process-identity checks removed. |
| device_record_video_status | deviceId | recording-status-v1 | Preserve recording/artifact state and partial finalization failures; no process-identity checks removed. |
| device_upload | deviceId, localPath, remotePath | file-upload-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_download | deviceId, remotePath, localPath | file-download-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_reset | deviceId | device-reset-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_install_app | deviceId, path | app-install-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| device_launch_app | deviceId | app-launch-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_session_status | deviceId | mobile-session-status-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_dump_ui | deviceId | ui-hierarchy-v1 | Preserve complete hierarchy source; remove known transport paths, not UI fields. |
| mobile_tap | deviceId, x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_double_tap | deviceId, x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_long_press | deviceId, x, y | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_swipe | deviceId, x1, y1, x2, y2 | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_drag | deviceId, x1, y1, x2, y2 | pointer-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_type_text | deviceId, text | text-action-v1 | Acknowledge typing with length; do not echo entered text. |
| mobile_key | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_home | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_back | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_forward | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_recents | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_power | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_lock | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_unlock | deviceId | key-action-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_rotate_left | deviceId | orientation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_rotate_right | deviceId | orientation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_set_orientation | deviceId, orientation | orientation-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_open_url | deviceId, url | url-open-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_install_app | deviceId, path | app-install-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_launch_app | deviceId | app-launch-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_uninstall_app | deviceId | app-uninstall-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_stop_app | deviceId | app-stop-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_clear_app_data | deviceId | app-data-clear-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_grant_permission | deviceId | permission-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_revoke_permission | deviceId | permission-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_set_location | deviceId, latitude, longitude | location-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_set_battery | deviceId | battery-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_set_network | deviceId | network-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_toggle_airplane_mode | deviceId, enabled | network-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_set_clipboard | deviceId, text | clipboard-set-v1 | Preserve setter result; internal routing metadata omitted. |
| mobile_get_clipboard | deviceId | clipboard-get-v1 | Preserve requested clipboard text exactly. |
| mobile_wait_for_text | deviceId, text | wait-text-v1 | Return found/text/timeout; full observed source available in detail. Per-poll safety checks retained. |
| mobile_wait_for_app | deviceId | wait-app-v1 | Preserve semantic fields; compact known success metadata only; retain fresh provider/owner checks. |
| mobile_screenshot | deviceId | image-content-v1 | Preserve native image bytes and screenshot geometry/incarnation; no image-to-text duplication. |
| mobile_run_flow | steps | flow-result-v1 | Bounded ordered steps, fresh broker scope per step; project each selected tool result independently. |
| device_run_flow | steps | flow-result-v1 | Bounded ordered steps, fresh broker scope per step; project each selected tool result independently. |

## Verification limits

Source/fixture coverage is exhaustive for this inventory. Platform-specific tests use isolated provider fixtures; they do not certify real Windows, macOS, iOS or Android hardware from this Linux workspace. Read-only host smoke and final regression counts are recorded with delivery. Newly added tools/functions require a new audit baseline.

## Current-goal review (baseline `0ed79c0f`)

Independent request and response audits re-enumerated all 93 tools: 48 device,
8 display and 37 mobile, with 57,211 characters in the serialized catalog. The
historical table above proves inventory coverage, not complete minimization:
partial fixture assertions and missing provider metadata hid additional gaps.

The first correction recognizes successful container-QEMU image list/import
envelopes and removes envelope ownership plus image ownership/timestamps. Image
paths remain usable. Inventory now uses the existing compact provider-plan
projection for direct devices and nested backend devices. Exact producer-shaped
fixtures verify omissions, failed/unknown records, and original detailed output.

These source-confirmed issues are now addressed by the follow-up sections below:

- Canonical discovery replaces six redundant mobile aliases; explicit orientation
  avoids misleading relative rotation shortcuts.
- Flows expose their action set, inherit a shared target safely, reject empty or
  malformed steps, and return native screenshots directly.
- Sole-backend selectors are implicit and platform-specific inputs have concise
  guidance; creation exposes named inputs.
- The quick start reuses returned IDs and avoids unconditional status chains.
- Sandbox/macOS inventory removes executable wiring and duplicate discovery.
- QEMU projection removes internal directory wiring and repeated successful
  observations while preserving unique failure/recovery and artifact evidence.
- Direct iOS and broker Appium observations share a bounded remaining allowance.

The final tool-family verification combines realistic success/failure and
opaque-data fixtures; registry counts alone do not establish native coverage.
Native provider execution remains distinct from fixture and source coverage.

## Canonical catalog and flow consolidation (baseline `b8a8e6f5`)

The accepted registry retains 93 operations while discovery advertises 87. Six
legacy mobile names no longer compete with device install/launch/screenshot,
explicit orientation and the canonical flow. Accepted registries still drive
legacy diagnostics, projection and raw broker capability checks. Legacy dispatch
is unchanged because explicit mobile broker aliases use Appium while canonical
device actions use native routing.

The canonical flow exposes its finite 53-action enum and shared target fields;
its serialized catalog measures 55,050 bytes versus 57,211 before consolidation.
Step normalization precedes atomic target inheritance, avoiding stale backend or
incarnation when a step switches targets. Confirmation and transport controls
are never inherited. Empty and malformed flows fail before affected execution.
The quick start now reuses returned identities and avoids unconditional
prerequisite/inventory/status chains. Detailed raw capability diagnostics may
retain legacy names; default discovery omits capability arrays.

The final response follow-up supersedes screenshot summaries with native content
and step references, removing the required follow-up screenshot call.

## Input clarity (baseline `06594d27`)

Eleven single-backend tools hide the selector in discovery and apply a bounded
tool-specific default after argument normalization. Accepted schemas retain old
explicit selectors; malformed or contradictory selectors fail before providers.
This also prevents owned QEMU IDs from overriding an explicitly different backend.
The real-provider verifier uses the same tool-aware normalization. No discovery,
owner lookup or authorization check is cached or broadened.

Creation hides the generic options wrapper in discovery while retaining runtime
flattening and top-level precedence. Named platform controls remain available.
Concise descriptions explain creation alternatives, Android/iOS app identifiers,
permissions, mobile keys and battery controls. These descriptions intentionally
spend catalog text where it avoids guessing inputs; raw catalog bytes alone do
not measure failed calls or repeated lookup costs.

## Final response and native-flow verification (baseline `baeb02d5`)

The current public catalog has 87 tools; all 93 accepted identities retain
semantic output fixtures, including six callable legacy aliases. The historical
inventory above includes those accepted aliases and their pre-default selectors.
The input-clarity section defines current sole-backend defaults.

Explicit QEMU projections cover lab/device aliases, singular/plural targets,
readiness/session results and nested start/stop/materialization results. They
hide generated lab/snapshot directories and executable wiring, retaining usable
workspace/artifact/export paths. Repeated successful process-only readiness
observations ignore generated IDs/timestamps when comparing semantic content;
unique checks, guest/custom diagnostics, failures, recovery and artifact-bearing
file operations remain. One realistic 50-observation list fixture shrinks from
34,600 to 879 serialized JSON bytes (97.46%); this measures that fixture, not all
responses or model tokens. Sandbox/macOS inventory keeps provider/prerequisite,
singleton/lock and inventory-limitation facts without repeated executable discovery.

Flows return native images/resources/audio alongside one JSON summary. A step's
`contentIndex` and `contentCount` identify its contiguous native range in the outer
MCP content array; index 0 holds JSON. Repeated requested screenshots remain
separate observations. Prior images survive later invalid steps or provider
exceptions, and native ranges survive failed-JSON compaction. Failed flows and
explicit outer `ok:false` JSON replies set MCP `isError:true`; nested opaque data
and successful no-match standalone observations retain their meaning. The
64 KiB failure bound covers JSON text, not native attachments.

Changed named-function review: `qemuRecord`, `qemuHistory`, `qemuTarget`,
`qemuOperation`, `target`, inventory discovery projection, `compactToolValue`,
`serializedJsonResult`, `jsonResult`, `flowJsonResult`, `summarizeContentItem`,
`summarizeToolResult`, and `handleRunFlow`. The earlier per-function audit remains
the baseline for unchanged functions; these explicit paths are regression tested.

| Family | Evidence |
|---|---|
| Accepted/public catalogs, actions, failures, opaque data | all-tools-output, canonical-flow, input-clarity, tool-guidance |
| QEMU metadata, nested results, histories and source detail bypass | provider-output, image-inventory-output, MCP Linux provider suites |
| Sandbox/macOS provider discovery and retained contention evidence | provider-output plus existing platform MCP fixture suites |
| Hyper-V identity, geometry, failures and artifacts | hyper-v-public-response |
| Mobile waits, clipboard, recording and helper results | wait-output, public-output, provider MCP fixtures |
| Mixed native content, repeated images, stop/continue/throw and JSON bounds | flow-output, responses, flow-wait |
| Broker preparation count and fresh per-step authority | broker-call-flow, canonical-flow |

Known ceiling: Unknown shapes and unique history remain unfiltered deliberately.
Source, producer fixtures and packaged stdio tests establish their stated
contracts; this Linux verification does not certify every native host/device.
