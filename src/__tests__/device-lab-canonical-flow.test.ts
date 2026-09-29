import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep public dispatch, normalization, policy and serialization; substitute only
// transport registration and provider results, capturing the arguments they see.
const fixture = vi.hoisted(() => ({
    handlers: [] as Array<(request: any) => Promise<any>>,
    calls: [] as Array<{ name: string; args: Record<string, any>; scope: number }>,
    scope: 0, nextScope: 0,
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return { ...actual, withBrokerOperation: async (fn: () => Promise<any>) => {
        const previous = fixture.scope;
        fixture.scope = ++fixture.nextScope;
        try { return await actual.withBrokerOperation(fn); } finally { fixture.scope = previous; }
    }, brokerAppium: async () => { throw new Error("unexpected inherited broker route"); },
    brokerDeviceTool: async () => { throw new Error("unexpected inherited device broker route"); } };
});
vi.mock("../../device-lab-mcp/src/backends/android.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleAndroidTool: async (name: string, args: Record<string, any>) => {
        fixture.calls.push({ name, args, scope: fixture.scope });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: 0, stdout: "", stderr: "", provider: "fixture" }) }], isError: false };
    },
}));
vi.mock("../../device-lab-mcp/src/backends/linux-vm.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { ALL_TOOLS, TOOLS, DEVICE_FLOW_TOOL_NAMES } from "../../device-lab-mcp/src/tools.mjs";

const hidden = ["mobile_install_app", "mobile_launch_app", "mobile_screenshot", "mobile_rotate_left", "mobile_rotate_right", "mobile_run_flow"];
const shared = { deviceId: "target-a", backend: "android-emulator", incarnationId: "a".repeat(32) };
const direct = { implicitBroker: false };
const step = (args: Record<string, unknown> = {}, tool = "mobile_tap") => ({ tool, arguments: { ...direct, x: 1, y: 2, ...args } });
const call = (name: string, args: Record<string, unknown>) => fixture.handlers[1]({ params: { name, arguments: args } });
const parse = (result: any) => JSON.parse(result.content[0].text);
const flow = (steps: unknown[], args: Record<string, unknown> = {}) => call("device_run_flow", { ...shared, ...args, steps });
beforeAll(async () => { await startServer(); });
beforeEach(() => { fixture.calls.length = 0; fixture.scope = 0; fixture.nextScope = 0; });

describe("canonical catalog and compatible dispatch", () => {
    it("advertises exactly 87 tools while retaining all 93 accepted identities", async () => {
        const catalog = await fixture.handlers[0]({});
        expect(catalog.tools).toEqual(TOOLS);
        expect(TOOLS).toHaveLength(87);
        expect(ALL_TOOLS).toHaveLength(93);
        expect(ALL_TOOLS.filter((entry: any) => !TOOLS.some((tool: any) => tool.name === entry.name)).map((entry: any) => entry.name).sort()).toEqual([...hidden].sort());
        expect(Buffer.byteLength(JSON.stringify(catalog.tools))).toBeLessThan(57211);
    });
    it("publishes a finite canonical flow enum, required tool and optional target defaults", () => {
        const schema: any = TOOLS.find((entry: any) => entry.name === "device_run_flow")!.inputSchema;
        expect(schema.required).toEqual(["steps"]);
        expect(schema.properties.steps).toMatchObject({ minItems: 1, maxItems: 50 });
        expect(schema.properties.steps.items.required).toEqual(["tool"]);
        expect(schema.properties.steps.items.properties).not.toHaveProperty("name");
        expect(schema.properties.steps.items.properties.tool.enum).toEqual(DEVICE_FLOW_TOOL_NAMES);
        expect(new Set(DEVICE_FLOW_TOOL_NAMES).size).toBe(DEVICE_FLOW_TOOL_NAMES.length);
        for (const key of ["deviceId", "backend", "incarnationId"]) expect(schema.properties).toHaveProperty(key);
        const visibleMobile = TOOLS.filter((entry: any) => entry.name.startsWith("mobile_")).map((entry: any) => entry.name);
        const priorDeviceAndDisplay = ["device_inventory", "device_record_video_status", "device_status", "device_screenshot",
            "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position",
            "device_window_list", "device_accessibility_snapshot", "display_current", "display_screenshot", "display_click",
            "display_double_click", "display_key", "display_type", "display_scroll", "display_cursor_position"];
        expect([...DEVICE_FLOW_TOOL_NAMES].sort()).toEqual([...priorDeviceAndDisplay, ...visibleMobile, "device_install_app", "device_launch_app"].sort());
        for (const name of [...hidden, "device_start", "device_exec", "device_run_flow", "device_broker_status"]) expect(DEVICE_FLOW_TOOL_NAMES).not.toContain(name);
    });
    it.each(hidden.filter(name => name !== "mobile_run_flow"))("keeps standalone %s dispatch and compact output", async (name) => {
        const result = await call(name, { ...shared, ...direct, path: "/fixture/app.apk", packageName: "example.app" });
        expect(result.isError).toBe(false);
        expect(fixture.calls[0].name).toBe(name);
        expect(parse(result)).toEqual({ ok: true, provider: "fixture" });
        const detailed = await call(name, { ...shared, ...direct, detail: true });
        expect(parse(detailed)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    });
    it.each(["device_install_app", "device_launch_app"])("accepts canonical %s in either flow without renaming dispatch", async (tool) => {
        for (const name of ["device_run_flow", "mobile_run_flow"]) {
            const result = parse(await call(name, { ...shared, steps: [step({ path: "/fixture/app.apk", packageName: "example.app" }, tool)] }));
            expect(result.ok).toBe(true);
            expect(fixture.calls.at(-1)?.name).toBe(tool);
        }
    });
    it.each(["mobile_screenshot", "mobile_rotate_left", "mobile_rotate_right"])("retains legacy flow step.name for %s", async (name) => {
        const result = parse(await flow([{ name, arguments: direct }]));
        expect(result.ok).toBe(true);
        expect(fixture.calls[0].name).toBe(name);
    });
    it.each(DEVICE_FLOW_TOOL_NAMES)("dispatches advertised flow choice %s through the existing handler", async (tool) => {
        const arguments_ = { ...direct, key: "HOME", text: "needle", packageName: "example.app", path: "/fixture/app.apk", confirmDestructive: true };
        const result = parse(await flow([{ tool, arguments: arguments_ }]));
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(fixture.calls.map(call => call.name)).toEqual([tool]);
    });
    it.each(["mobile_install_app", "mobile_launch_app", "device_start", "device_exec", "device_broker_status", "device_run_flow", "mobile_run_flow", "unknown_action"])("rejects %s in the canonical flow before dispatch", async (name) => {
        const result = parse(await flow([step({}, name)]));
        expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(result.results[0].error).toContain("does not allow step tool");
        expect(fixture.calls).toEqual([]);
    });
});

describe("shared target selection", () => {
    it("inherits only target fields and starts a fresh broker scope for every step", async () => {
        const input = [step(), step({ deviceId: shared.deviceId, incarnationId: "b".repeat(32) })];
        const original = structuredClone(input);
        expect(parse(await flow(input, { viaBroker: true, autolaunch: true, force: true, confirmDestructive: true, token: "private", port: 1234 })).ok).toBe(true);
        expect(fixture.calls.map(call => call.args)).toEqual([
            { deviceId: shared.deviceId, backend: shared.backend, ...direct, x: 1, y: 2 },
            { ...shared, ...direct, x: 1, y: 2, incarnationId: "b".repeat(32) },
        ]);
        expect(fixture.calls[0].scope).toBeGreaterThan(0);
        expect(fixture.calls[0].scope).not.toBe(fixture.calls[1].scope);
        expect(input).toEqual(original);
    });
    it("inherits incarnation only for actions that accept it", async () => {
        expect(parse(await flow([step({}, "device_click"), step({}, "mobile_tap")])).ok).toBe(true);
        expect(fixture.calls[0].args.incarnationId).toBe(shared.incarnationId);
        expect(fixture.calls[1].args).not.toHaveProperty("incarnationId");
    });
    it.each([{ deviceId: "target-b" }, { backend: "ios-simulator" }])("resets the entire inherited target group on %j", async (override) => {
        expect(parse(await flow([step(override)])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...direct, x: 1, y: 2, ...override });
    });
    it("normalizes nested options before target comparison and honors top-level precedence", async () => {
        expect(parse(await flow([step({ options: { deviceId: "target-b", backend: "ios-simulator", incarnationId: "nested" } })])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...direct, x: 1, y: 2, deviceId: "target-b", backend: "ios-simulator", incarnationId: "nested" });
        fixture.calls.length = 0;
        expect(parse(await flow([step({ options: { deviceId: "target-b", incarnationId: "nested" }, deviceId: shared.deviceId })])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...shared, ...direct, x: 1, y: 2, incarnationId: "nested" });
    });
    it.each([null, "../outside", 42, ""])("preserves invalid explicit deviceId %j for validation", async (deviceId) => {
        const result = parse(await flow([step({ deviceId })]));
        expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(JSON.stringify(result)).toContain("device-id-invalid");
        expect(fixture.calls).toEqual([]);
    });
    it("does not replace explicitly null incarnation or backend with defaults", async () => {
        expect(parse(await flow([step({ incarnationId: null }), step({ backend: null })])).ok).toBe(true);
        expect(fixture.calls[0].args.incarnationId).toBeNull();
        expect(fixture.calls[1].args).toEqual({ ...direct, x: 1, y: 2, backend: null });
    });
    it.each(["display_key", "device_inventory"])("does not add target fields to target-neutral %s", async (tool) => {
        expect(parse(await flow([step({}, tool)])).ok).toBe(true);
        expect(fixture.calls[0].args).toEqual({ ...direct, x: 1, y: 2 });
    });
    it.each([null, [], "bad", 7, false])("rejects explicitly malformed arguments %j before dispatch", async (arguments_) => {
        const result = parse(await flow([{ tool: "mobile_tap", arguments: arguments_ }, step()], { stopOnError: false }));
        expect(result.ok).toBe(false);
        expect(result.results[0].error).toMatch(/arguments.*object/);
        expect(result.results[1].isError).toBe(false);
        expect(fixture.calls).toHaveLength(1);
    });
});

describe("flow policy and bounds", () => {
    it.each(["mobile_uninstall_app", "mobile_clear_app_data", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode"])("does not inherit confirmation for %s", async (tool) => {
        const args = { packageName: "example.app", level: 50, wifi: false, enabled: false };
        const denied = parse(await flow([step(args, tool)], { confirmDestructive: true, force: true }));
        expect(denied).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(JSON.stringify(denied)).toContain("destructive-action-confirmation-required");
        expect(fixture.calls).toEqual([]);
        const allowed = parse(await flow([step({ ...args, confirmDestructive: true }, tool)]));
        expect(allowed.ok).toBe(true);
        expect(fixture.calls).toHaveLength(1);
    });
    it.each(["device_run_flow", "mobile_run_flow"])("%s rejects empty and oversized flows before dispatch", async (name) => {
        for (const steps of [[], Array.from({ length: 51 }, () => step())]) {
            const result = await call(name, { ...shared, steps });
            expect(result.isError).toBe(true);
            expect(fixture.calls).toEqual([]);
        }
        const valid = parse(await call(name, { ...shared, steps: Array.from({ length: 50 }, () => step()) }));
        expect(valid.ok).toBe(true);
        expect(fixture.calls).toHaveLength(50);
        expect(new Set(fixture.calls.map(call => call.scope)).size).toBe(50);
    });
});
