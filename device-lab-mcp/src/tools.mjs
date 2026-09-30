import { TOOLS as OPERATIONS, DEVICE_FLOW_TOOL_NAMES as FLOW_OPERATIONS, SINGLE_BACKEND_TOOL_DEFAULTS as DEFAULTS } from "./operation-tools.mjs";
import { createInputSchema } from "./creation-input.mjs";

// Provider operation identities are private. MCP accepts only this action catalog.
const merged = {
    mobile_tap: "click", mobile_double_tap: "double_click",
    mobile_type_text: "type", mobile_key: "key",
    mobile_rotate_left: "set_orientation", mobile_rotate_right: "set_orientation",
    device_list: "list_devices", mobile_session_status: "status",
    device_broker_status: "backends", device_target_list: "status", device_readiness_probe: "status", device_guest_agent_status: "status",
    device_snapshot_list: "snapshot", device_snapshot_create: "snapshot", device_snapshot_restore: "snapshot", device_snapshot_delete: "snapshot",
    device_record_video_start: "record_video", device_record_video_stop: "record_video", device_record_video_status: "record_video",
    mobile_grant_permission: "permission", mobile_revoke_permission: "permission",
    mobile_get_clipboard: "clipboard", mobile_set_clipboard: "clipboard",
    mobile_dump_ui: "ui", device_accessibility_snapshot: "ui",
};
export function publicToolName(operation) {
    if (typeof operation !== "string") return operation;
    if (operation === "display_current") return "status";
    if (operation.startsWith("display_")) return operation.slice(8);
    return Object.hasOwn(merged, operation) ? merged[operation] : operation.replace(/^(device|mobile)_/, "");
}

const omitted = new Set(["device_broker_status", "device_disk_materialize", "device_session_open", "device_guest_agent_provision", "device_target_list", "device_readiness_probe", "device_guest_agent_status", "mobile_session_status", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete", "device_record_video_start", "device_record_video_stop", "mobile_revoke_permission", "mobile_set_clipboard", "mobile_dump_ui"]);
export const GROUP_OPERATIONS = Object.freeze({
    snapshot: { list: "device_snapshot_list", create: "device_snapshot_create", restore: "device_snapshot_restore", delete: "device_snapshot_delete" },
    record_video: { start: "device_record_video_start", stop: "device_record_video_stop", status: "device_record_video_status" },
    permission: { grant: "mobile_grant_permission", revoke: "mobile_revoke_permission" },
});
const selected = OPERATIONS.filter(({ name }) => !name.startsWith("display_") && !omitted.has(name)
    && !["device_workspace_sync", "device_artifacts_export"].includes(name)
    && !["mobile_tap", "mobile_double_tap", "mobile_type_text", "mobile_key"].includes(name));
const operationByName = new Map(selected.map(({ name }) => [publicToolName(name), name]));
operationByName.set("move", "device_cursor_position");
export function toolOperation(name, args = {}) {
    if (Object.hasOwn(GROUP_OPERATIONS, name)) return typeof args?.action === "string" && Object.hasOwn(GROUP_OPERATIONS[name], args.action) ? GROUP_OPERATIONS[name][args.action] : undefined;
    if (name === "clipboard") return Object.hasOwn(args || {}, "text") ? "mobile_set_clipboard" : "mobile_get_clipboard";
    return operationByName.get(name);
}
export function flowOperationAllowed(name, args = {}) { return FLOW_OPERATIONS.includes(toolOperation(name, args)); }
export function isSimpleAction(name, operation) { return SIMPLE_ACTIONS.has(name) || (name === "clipboard" && operation === "mobile_set_clipboard"); }
export const SINGLE_BACKEND_TOOL_DEFAULTS = Object.freeze(Object.fromEntries(
    Object.entries(DEFAULTS).filter(([name]) => selected.some((tool) => tool.name === name)).map(([name, backend]) => [publicToolName(name), backend])));
export const DEVICE_FLOW_TOOL_NAMES = [...new Set(FLOW_OPERATIONS
    .filter((name) => !name.startsWith("display_"))
    .map(publicToolName).filter((name) => operationByName.has(name))), "move"];

const mobileKey = OPERATIONS.find(({ name }) => name === "mobile_key").inputSchema;
const renameReferences = (text) => text.replace(/\b(?:device|mobile|display)_[a-z_]+\b/g, publicToolName);
export const TOOLS = selected.map((operation) => {
    const tool = structuredClone(operation);
    tool.name = publicToolName(operation.name);
    tool.description = renameReferences(tool.description);
    const schema = tool.inputSchema;
    const group = GROUP_OPERATIONS[tool.name];
    if (group) {
        const variants = Object.entries(group).map(([action, name]) => {
            const original = OPERATIONS.find((entry) => entry.name === name).inputSchema;
            Object.assign(schema.properties, structuredClone(original.properties));
            return { properties: { action: { const: action } }, required: [...new Set(["action", ...original.required])], ...(original.anyOf ? { anyOf: structuredClone(original.anyOf) } : {}) };
        });
        schema.properties.action = { type: "string", enum: Object.keys(group) };
        schema.required = ["deviceId", "action"];
        delete schema.anyOf;
        schema.oneOf = variants;
        tool.description = `${tool.name}: ${Object.keys(group).join(", ")}. Select an explicit action for this device.`;
    }
    if (tool.name === "snapshot") tool.description += " Restore and delete require confirmDestructive:true; create requires snapshotName, restore/delete accept snapshotName or snapshotId.";
    if (tool.name === "clipboard") {
        schema.properties.text = { type: "string", description: "Set clipboard when present, including an empty string. Omit to read." };
        tool.description = "Read the device clipboard, or write it when text is provided.";
    }
    if (tool.name === "ui") tool.description = "Inspect mobile UI hierarchy or desktop accessibility for this device.";
    if (["click", "double_click"].includes(tool.name)) {
        tool.description = `${tool.name === "click" ? "Click or tap" : "Double-click or double-tap"} at screenshot x,y. Mobile supports only the left button. Hyper-V requires the screenshot incarnationId.`;
    }
    if (tool.name === "type") tool.description = "Type text into the focused device. Hyper-V requires the screenshot incarnationId; Windows VM console typing supports ASCII only.";
    if (tool.name === "key") {
        schema.properties.key.minLength = 1;
        schema.properties.key.description = "Desktop key or combination (Enter, Ctrl+C); Android ADB key name (KEYCODE_HOME); iOS Appium key value.";
        schema.properties.keyCode = mobileKey.properties.keyCode;
        schema.required = ["deviceId"];
        schema.anyOf = mobileKey.anyOf;
        tool.description = "Send a key or combination. Desktop: Enter, Ctrl+C, Alt+Tab. Android also accepts numeric keyCode. Unsupported keys fail.";
    }
    if (tool.name === "cursor_position") {
        delete schema.properties.x;
        delete schema.properties.y;
        tool.description = "Read the device cursor position. Use move to move it.";
    }
    if (tool.name === "run_flow") {
        schema.properties.steps.items.properties.tool.enum = DEVICE_FLOW_TOOL_NAMES;
        tool.description = renameReferences(operation.description).replace(/backend,?\s*/g, "") + " Recording supports only status in flows.";
        schema.properties.deviceId.description = "Device ID inherited by steps that omit it. Each step resolves ownership independently.";
    }
    if (tool.name === "status") tool.description = "Read device state and read-only automation diagnostics. Running container QEMU devices include live readiness; stopped devices do not run guest probes. Appium is optional and is not started by status.";
    if (tool.name === "create") {
        tool.inputSchema = createInputSchema(schema);
        tool.description = "Create a device, then start to boot. Android needs systemImage, or avdName to reuse; iOS needs deviceType and runtime, or udid to reuse. Hyper-V, macOS and container QEMU fields depend on backend. Physical devices use attach.";
    }
    if (tool.name === "reset") {
        schema.properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => ["deviceId", "confirmDestructive", "detail"].includes(key)));
        delete schema.anyOf;
        tool.description = "Erase an owned iOS Simulator completely. Requires confirmDestructive:true. To clear only one app, use clear_app_data.";
    }
    return tool;
});
const move = structuredClone(TOOLS.find(({ name }) => name === "cursor_position"));
move.name = "move";
move.description = "Move the cursor to screenshot x,y on the current X11 display or Hyper-V Windows/Linux VM. Other devices return unsupported. Hyper-V requires the screenshot incarnationId.";
move.inputSchema.properties.x = { type: "integer", minimum: 0 };
move.inputSchema.properties.y = { type: "integer", minimum: 0 };
move.inputSchema.required = ["deviceId", "x", "y"];
TOOLS.push(move);

// Existing devices carry their provider identity; callers never select it again.
for (const tool of TOOLS) {
    if (tool.inputSchema.properties.detail) tool.inputSchema.properties.detail.description = "Include diagnostics.";
    if (tool.inputSchema.properties.helperTimeoutMs) {
        tool.inputSchema.properties.timeoutMs ||= { ...tool.inputSchema.properties.helperTimeoutMs, description: "Timeout (ms); default is automatic." };
        delete tool.inputSchema.properties.helperTimeoutMs;
    }
    if (tool.inputSchema.required?.includes("deviceId") || tool.name === "run_flow") {
        delete tool.inputSchema.properties.backend;
        tool.inputSchema.required = tool.inputSchema.required?.filter((key) => key !== "backend");
    }
}

export const SIMPLE_ACTIONS = new Set([
    "click", "double_click", "move", "type", "key", "scroll", "long_press", "swipe", "drag",
    "home", "back", "forward", "recents", "power", "lock", "unlock", "set_orientation",
    "open_url", "set_location", "set_battery", "set_network", "toggle_airplane_mode",
]);
