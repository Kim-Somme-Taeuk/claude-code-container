import { describe, expect, it } from "vitest";
import { BROKER_DEVICE_TOOL_PARAM_KEYS } from "../../device-lab-mcp/src/broker.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const BROKER_DEVICE_TOOL_ROUTABLE_TOOLS = new Set([
    "exec",
    "screenshot",
    "click",
    "double_click",
    "key",
    "type",
    "scroll",
    "cursor_position",
    "window_list",
    "accessibility_snapshot",
    "record_video_start",
    "record_video_stop",
    "record_video_status",
    "upload",
    "download",
    "reset",
    "install_app",
    "launch_app",
    "automation_status",
    "dump_ui",
    "click",
    "double_click",
    "long_press",
    "swipe",
    "drag",
    "type",
    "key",
    "home",
    "back",
    "forward",
    "recents",
    "power",
    "lock",
    "unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "set_orientation",
    "open_url",
    "install_app",
    "launch_app",
    "uninstall_app",
    "stop_app",
    "clear_app_data",
    "grant_permission",
    "revoke_permission",
    "set_location",
    "set_battery",
    "set_network",
    "toggle_airplane_mode",
    "set_clipboard",
    "get_clipboard",
    "wait_for_text",
    "wait_for_app",
    "screenshot",
]);

const BROKER_ROUTE_ONLY_PROPERTIES = new Set([
    "detail", // Presentation-only: stripped before provider dispatch.
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "port",
    "brokerPort",
    "rpcTimeoutMs",
    "launchTimeoutMs",
]);

describe("device-lab broker device tool param coverage", () => {
    it("keeps broker device tool forwarded params in lockstep with routed tool schemas", () => {
        expect(new Set(BROKER_DEVICE_TOOL_PARAM_KEYS).size).toBe(BROKER_DEVICE_TOOL_PARAM_KEYS.length);

        const forwarded = new Set(BROKER_DEVICE_TOOL_PARAM_KEYS);
        const missingByTool = TOOLS
            .filter((tool) => BROKER_DEVICE_TOOL_ROUTABLE_TOOLS.has(tool.name))
            .map((tool) => {
                const missing = Object.keys(tool.inputSchema?.properties || {})
                    .filter((property) => !BROKER_ROUTE_ONLY_PROPERTIES.has(property))
                    .filter((property) => !forwarded.has(property))
                    .sort();
                return { name: tool.name, missing };
            })
            .filter((item) => item.missing.length > 0);

        expect(missingByTool).toEqual([]);
    });
});
