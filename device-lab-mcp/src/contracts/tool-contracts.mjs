import { TOOLS, toolOperation, SIMPLE_ACTIONS, GROUP_OPERATIONS, isSimpleAction } from "../tools.mjs";

function objectValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function contractError(tool, detail, payload) {
    const keys = objectValue(payload) ? Object.keys(payload).sort().join(", ") : typeof payload;
    return new Error(`${tool} response contract violation: ${detail}; received keys: ${keys}`);
}

const contractGroups = {
    "file-list-v1": ["device_list_files"],
    "backend-catalog-v1": ["device_backends"],
    "broker-status-v1": ["device_broker_status"],
    "device-list-v1": ["device_list"],
    "device-inventory-v1": ["device_inventory"],
    "vm-image-list-v1": ["device_image_list"],
    "vm-image-import-v1": ["device_image_import"],
    "vm-operation-v1": ["device_disk_materialize", "device_reboot", "device_workspace_sync", "device_artifacts_export", "device_guest_agent_status", "device_guest_agent_provision"],
    "vm-target-list-v1": ["device_target_list"],
    "vm-readiness-v1": ["device_readiness_probe"],
    "vm-session-v1": ["device_session_open"],
    "wireless-status-v1": ["device_wireless"],
    "display-target-v1": ["display_current"],
    "image-content-v1": ["display_screenshot", "device_screenshot"],
    "pointer-action-v1": ["display_click", "display_double_click", "device_click", "device_double_click", "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe", "mobile_drag"],
    "key-action-v1": ["display_key", "device_key", "mobile_key", "mobile_home", "mobile_back", "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock", "mobile_unlock"],
    "text-action-v1": ["display_type", "device_type", "mobile_type_text"],
    "scroll-action-v1": ["display_scroll", "device_scroll"],
    "cursor-position-v1": ["display_cursor_position", "device_cursor_position"],
    "lifecycle-device-v1": ["device_create", "device_start", "device_stop", "device_status"],
    "physical-attach-v1": ["device_attach"],
    "physical-detach-v1": ["device_detach"],
    "lifecycle-delete-v1": ["device_delete"],
    "command-execution-v1": ["device_exec"],
    "window-list-v1": ["device_window_list"],
    "accessibility-snapshot-v1": ["device_accessibility_snapshot"],
    "base-image-device-v1": ["device_base_image_create", "device_base_image_clone"],
    "snapshot-create-v1": ["device_snapshot_create"],
    "snapshot-list-v1": ["device_snapshot_list"],
    "snapshot-restore-v1": ["device_snapshot_restore"],
    "snapshot-delete-v1": ["device_snapshot_delete"],
    "recording-start-v1": ["device_record_video_start"],
    "recording-stop-v1": ["device_record_video_stop"],
    "recording-status-v1": ["device_record_video_status"],
    "file-upload-v1": ["device_upload"],
    "file-download-v1": ["device_download"],
    "device-reset-v1": ["device_reset"],
    "app-install-v1": ["device_install_app"],
    "app-launch-v1": ["device_launch_app"],
    "mobile-session-status-v1": ["mobile_session_status"],
    "ui-hierarchy-v1": ["mobile_dump_ui"],
    "orientation-v1": ["mobile_set_orientation"],
    "url-open-v1": ["mobile_open_url"],
    "app-uninstall-v1": ["mobile_uninstall_app"],
    "app-stop-v1": ["mobile_stop_app"],
    "app-data-clear-v1": ["mobile_clear_app_data"],
    "permission-v1": ["mobile_grant_permission", "mobile_revoke_permission"],
    "location-v1": ["mobile_set_location"],
    "battery-v1": ["mobile_set_battery"],
    "network-v1": ["mobile_set_network", "mobile_toggle_airplane_mode"],
    "clipboard-set-v1": ["mobile_set_clipboard"],
    "clipboard-get-v1": ["mobile_get_clipboard"],
    "wait-text-v1": ["mobile_wait_for_text"],
    "wait-app-v1": ["mobile_wait_for_app"],
    "flow-result-v1": ["device_run_flow"],
};

const OPERATION_CONTRACTS = Object.fromEntries(
    Object.entries(contractGroups).flatMap(([contract, tools]) => tools.map((tool) => [tool, contract])),
);
export const DEVICE_LAB_OUTPUT_CONTRACTS = Object.freeze(Object.fromEntries(
    TOOLS.map(({ name }) => [name, Object.hasOwn(GROUP_OPERATIONS, name) || ["clipboard", "ui", "devices", "create_macos_vm"].includes(name) ? `${name}-group-v1` : SIMPLE_ACTIONS.has(name) ? "action-v1" : OPERATION_CONTRACTS[toolOperation(name)]]),
));

const requiredFieldsByContract = {
    "file-list-v1": ["entries"],
    "window-list-v1": ["windows"],
    "app-install-v1": ["installed"],
    "app-launch-v1": ["launched"],
    "device-list-v1": ["devices"],
    "vm-image-list-v1": ["images"],
    "vm-image-import-v1": ["image"],
    "vm-target-list-v1": ["targets"],
    "vm-readiness-v1": ["readiness"],
    "vm-session-v1": ["session"],
    "display-target-v1": ["deviceId"],
    "cursor-position-v1": [], // validateObservation handles compact and diagnostic forms.
    "lifecycle-device-v1": ["device"],
    "physical-attach-v1": ["device"],
    "physical-detach-v1": ["detached"],
    "lifecycle-delete-v1": ["deleted"],
    "base-image-device-v1": ["device"],
    "snapshot-create-v1": ["snapshot"],
    "snapshot-list-v1": ["snapshots"],
    "snapshot-restore-v1": ["device"],
    "snapshot-delete-v1": ["deleted"],
    "recording-start-v1": ["recording"],
    "recording-status-v1": ["recording"],
    "file-upload-v1": ["uploaded"],
    "file-download-v1": ["downloaded"],
    "mobile-session-status-v1": ["deviceId"],
    "ui-hierarchy-v1": ["source"],
    "app-stop-v1": ["stopped"],
    "location-v1": ["location"],
    "clipboard-get-v1": ["text"],
    "flow-result-v1": ["results"],
};

const deviceObjectContracts = new Set(["lifecycle-device-v1", "physical-attach-v1", "base-image-device-v1", "snapshot-restore-v1"]);
const arrayFields = new Set(["devices", "images", "results", "targets", "entries", "windows", "snapshots"]);

function validateInventory(tool, value, depth = 0) {
    const reject = (detail) => { throw contractError(tool, detail, value); };
    const nonempty = (item) => typeof item === "string" && item.trim().length > 0;
    if (!objectValue(value) || depth > 8) reject("inventory requires an object with devices or backends");
    if (value.ok === false || value.isError === true || value.error) reject("inventory operation failed");
    // Host broker inventory is wrapped in result; direct providers and the
    // aggregate discovery operation return their inventory at the top level.
    if (!("devices" in value) && !("backends" in value) && objectValue(value.result)) {
        validateInventory(tool, value.result, depth + 1);
        return;
    }
    if (!("devices" in value) && !("backends" in value)) reject("inventory requires devices or backends");
    if ("devices" in value && (!nonempty(value.backend) || !Array.isArray(value.devices)
        || value.devices.some(device => !objectValue(device) || !nonempty(device.deviceId)))) {
        reject("focused inventory requires backend and devices with nonempty deviceId");
    }
    if ("backends" in value) {
        if (!Array.isArray(value.backends)) reject("inventory backends must be an array");
        for (const entry of value.backends) {
            if (!objectValue(entry) || !nonempty(entry.backend)) reject("inventory entries require backend identity");
            // Unavailable backends remain useful aggregate observations.
            if (nonempty(entry.error)) continue;
            validateInventory(tool, entry, depth + 1);
        }
    }
    if (value.partial !== undefined && typeof value.partial !== "boolean") reject("inventory partial must be a boolean");
}

function validateObservation(tool, value, args) {
    const reject = (detail) => { throw contractError(tool, detail, value); };
    const nonempty = (item) => typeof item === "string" && item.trim().length > 0;
    if (tool === "devices" && toolOperation(tool, args) === "device_list") {
        const devices = Array.isArray(value) ? value : value.devices;
        if (!Array.isArray(devices) || devices.some(device => !objectValue(device) || !nonempty(device.deviceId))) reject("devices must contain objects with nonempty deviceId");
    }
    if (tool === "devices" && toolOperation(tool, args) === "device_inventory") validateInventory(tool, value);
    if (tool === "window_list") {
        if (!Array.isArray(value.windows) || value.windows.some(window => !objectValue(window)
            || typeof window.title !== "string"
            || (window.handle !== undefined && !nonempty(window.handle))
            || (window.processId !== undefined && (!Number.isSafeInteger(window.processId) || window.processId <= 0)))) {
            reject("windows require a string title, optional nonempty handle and positive integer processId");
        }
        if (value.truncated !== undefined && typeof value.truncated !== "boolean") reject("truncated must be a boolean");
    }
    if (tool === "install_app" && !nonempty(value.installed)) reject("installed must identify the installed app path");
    if (tool === "launch_app" && !nonempty(value.launched)) reject("launched must identify the app or component");
    if (tool === "cursor_position") {
        const cursor = objectValue(value.cursor) || value;
        if (![cursor.x, cursor.y].every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate))) reject("cursor x and y must be finite numbers");
    }
    if (["wait_for_text", "wait_for_app"].includes(tool)) {
        const outcomes = [value.matched, value.found, ...(tool === "wait_for_app" ? [value.running] : [])].filter(item => item !== undefined);
        if (!outcomes.length || outcomes.some(item => typeof item !== "boolean") || outcomes.some(item => item !== outcomes[0])) reject("wait requires a consistent boolean condition outcome");
    }
    if (tool === "list_files") {
        if (!Array.isArray(value.entries) || value.entries.some(entry => !objectValue(entry) || !nonempty(entry.name)
            || !["file", "directory", "symlink", "other"].includes(entry.type)
            || (entry.size !== undefined && (!Number.isFinite(entry.size) || entry.size < 0)))) reject("entries require a name, file type and optional nonnegative size");
        if (value.truncated !== undefined && typeof value.truncated !== "boolean") reject("truncated must be a boolean");
    }
    if (tool === "record_video") {
        if (args.action === "stop") {
            if (typeof value.stopped !== "boolean" && !Object.hasOwn(value, "recording")) reject("recording stop requires stopped or recording outcome");
        } else if (!Object.hasOwn(value, "recording")) reject("required recording field is missing");
        if (Object.hasOwn(value, "recording") && value.recording !== null && !objectValue(value.recording)) reject("recording must be an object or null");
        if (objectValue(value.recording) && typeof value.recording.active !== "boolean") reject("recording requires boolean active state");
    }
}

export function validateDeviceLabToolOutput(tool, payload, args = {}) {
    let contract = DEVICE_LAB_OUTPUT_CONTRACTS[tool];
    if (!contract) throw new Error(`No output contract registered for ${tool}`);
    // Check failure before specialized image/display/list success shortcuts.
    if (payload?.isError === true || payload?.ok === false || (typeof payload?.error === "string" && payload.error)) {
        const command = payload.result?.execution?.command || payload.selected?.body?.result?.execution?.command;
        const cause = command?.error || command?.stderr || command?.stdout;
        throw contractError(tool, `operation failed (${String(payload.error || "MCP error")})${cause ? `: ${String(cause).trim().slice(-512)}` : ""}`, payload);
    }
    if (contract.endsWith("-group-v1")) {
        const operation = toolOperation(tool, args);
        if (isSimpleAction(tool, operation) && payload === "ok") return payload;
        if (operation) contract = OPERATION_CONTRACTS[operation];
        else throw contractError(tool, tool === "devices" ? "view must be owned, available, or backends" : "action is required to validate grouped output", payload);
        if (tool === "ui") contract = "ui-group-v1";
    }
    if (contract === "action-v1") {
        if (payload === "ok") return payload;
        contract = OPERATION_CONTRACTS[toolOperation(tool, args)];
    }
    if (tool === "devices" && toolOperation(tool, args) === "device_list" && Array.isArray(payload)) {
        validateObservation(tool, payload, args);
        return payload;
    }
    if (tool === "status" && typeof payload?.deviceId === "string" && payload.kind === "display") return payload;
    if (contract === "image-content-v1") {
        if (Array.isArray(payload?.content) && payload.content.some((item) => item?.type === "image"
            && typeof item.data === "string" && item.data.length > 0
            && typeof item.mimeType === "string" && item.mimeType.startsWith("image/"))) return payload;
        throw contractError(tool, "required MCP image content is missing", payload);
    }
    const value = objectValue(payload);
    if (!value) throw contractError(tool, "expected an object", payload);
    if (value.ok === false || (typeof value.error === "string" && value.error)) {
        const command = value.result?.execution?.command || value.selected?.body?.result?.execution?.command;
        const providerDetail = command?.error || command?.stderr || command?.stdout;
        const detail = providerDetail ? `: ${String(providerDetail).trim().slice(-512)}` : "";
        throw contractError(tool, `operation failed (${String(value.error || "unknown-error")})${detail}`, payload);
    }
    if (tool === "ui" && !(typeof value.source === "string" || (objectValue(value.accessibility) && "root" in value.accessibility && typeof value.accessibility.nodeCount === "number"))) throw contractError(tool, "required mobile source or desktop accessibility tree is missing", payload);
    validateObservation(tool, value, args);
    for (const field of requiredFieldsByContract[contract] || []) {
        if (!(field in value)) throw contractError(tool, `required ${field} field is missing`, payload);
        if (arrayFields.has(field) && !Array.isArray(value[field])) throw contractError(tool, `required ${field} array is invalid`, payload);
        if (field === "deviceId" && (typeof value[field] !== "string" || !value[field])) throw contractError(tool, "required deviceId string is missing", payload);
    }
    if (deviceObjectContracts.has(contract)) {
        const device = objectValue(value.device);
        if (!device) throw contractError(tool, "required device object is missing", payload);
        if (typeof device.deviceId !== "string" || !device.deviceId) throw contractError(tool, "required device.deviceId string is missing", payload);
    }
    return value;
}

export function hasDeviceLabOutputContract(tool) {
    return Object.hasOwn(DEVICE_LAB_OUTPUT_CONTRACTS, tool);
}
