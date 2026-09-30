import { TOOLS as OPERATIONS, DEVICE_FLOW_TOOL_NAMES as FLOW_OPERATIONS, SINGLE_BACKEND_TOOL_DEFAULTS as DEFAULTS } from "./operation-tools.mjs";

// Provider operation identities are private. MCP accepts only this action catalog.
const merged = {
    mobile_tap: "click", mobile_double_tap: "double_click",
    mobile_type_text: "type", mobile_key: "key",
    mobile_rotate_left: "set_orientation", mobile_rotate_right: "set_orientation",
    device_list: "list_devices", mobile_session_status: "automation_status",
};
export function publicToolName(operation) {
    if (typeof operation !== "string") return operation;
    if (operation === "display_current") return "status";
    if (operation.startsWith("display_")) return operation.slice(8);
    return Object.hasOwn(merged, operation) ? merged[operation] : operation.replace(/^(device|mobile)_/, "");
}

const selected = OPERATIONS.filter(({ name }) => !name.startsWith("display_")
    && !["mobile_tap", "mobile_double_tap", "mobile_type_text", "mobile_key"].includes(name));
const operationByName = new Map(selected.map(({ name }) => [publicToolName(name), name]));
operationByName.set("move", "device_cursor_position");
export function toolOperation(name) { return operationByName.get(name); }
export const SINGLE_BACKEND_TOOL_DEFAULTS = Object.freeze(Object.fromEntries(
    Object.entries(DEFAULTS).map(([name, backend]) => [publicToolName(name), backend])));
export const DEVICE_FLOW_TOOL_NAMES = [...new Set(FLOW_OPERATIONS
    .filter((name) => !name.startsWith("display_"))
    .map(publicToolName)), "move"];

const mobileKey = OPERATIONS.find(({ name }) => name === "mobile_key").inputSchema;
const renameReferences = (text) => text.replace(/\b(?:device|mobile|display)_[a-z_]+\b/g, publicToolName);
export const TOOLS = selected.map((operation) => {
    const tool = structuredClone(operation);
    tool.name = publicToolName(operation.name);
    tool.description = renameReferences(tool.description);
    const schema = tool.inputSchema;
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
    if (tool.name === "run_flow") schema.properties.steps.items.properties.tool.enum = DEVICE_FLOW_TOOL_NAMES;
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
    if (tool.inputSchema.required?.includes("deviceId") || tool.name === "run_flow") {
        delete tool.inputSchema.properties.backend;
        tool.inputSchema.required = tool.inputSchema.required?.filter((key) => key !== "backend");
    }
}

export const SIMPLE_ACTIONS = new Set([
    "click", "double_click", "move", "type", "key", "scroll", "long_press", "swipe", "drag",
    "home", "back", "forward", "recents", "power", "lock", "unlock", "set_orientation",
    "open_url", "set_clipboard", "set_location", "set_battery", "set_network", "toggle_airplane_mode",
]);
