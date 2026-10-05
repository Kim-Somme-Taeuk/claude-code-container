import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore pure JS MCP dependency
import { PNG } from "pngjs";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[], png: "", fail: "" }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: unknown) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/display/x11.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    handleDisplayTool: (name: string, args: any) => {
        fixture.calls.push({ name, args });
        if (fixture.fail === name) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "display-unavailable" }) }] };
        return name === "display_screenshot" ? { content: [{ type: "image", mimeType: "image/png", data: fixture.png }] }
            : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
}));
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { TOOLS, toolOperation, flowOperationAllowed } from "../../device-lab-mcp/src/tools.mjs";
import { requiresOwnerDeviceOperation } from "@ccc/device-lab/providers/state/device-operation-policy.mjs";
const call = (name: string, args: any) => fixture.handlers[1]({ params: { name, arguments: { implicitBroker: false, ...args } } });
beforeAll(async () => { await startServer(); });
beforeEach(() => {
    fixture.calls.length = 0; fixture.fail = "";
    fixture.png = PNG.sync.write({ width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4, 255) }).toString("base64");
});
describe("desktop AX public journeys", () => {
    it("adds only focus_window and keeps drag's public name across platforms", () => {
        expect(TOOLS).toHaveLength(59);
        expect(toolOperation("drag")).toBe("device_drag");
        expect(toolOperation("focus_window")).toBe("device_focus_window");
        expect(flowOperationAllowed("drag")).toBe(true);
        expect(flowOperationAllowed("focus_window")).toBe(true);
        for (const backend of ["windows", "macos", "windows-vm", "linux-vm"]) {
            expect(requiresOwnerDeviceOperation(backend, "device_drag")).toBe(true);
            expect(requiresOwnerDeviceOperation(backend, "device_focus_window")).toBe(true);
        }
    });
    it.each(["windows-sandbox", "macos-vm", "windows-vm", "linux-vm"])("advertises move for named desktop %s", backend => {
        const output = actionResult("devices", "device_list", { content: [{ type: "text", text: JSON.stringify({devices:[{ id:"desktop", name:"My desktop", backend, provider:"hyper-v", capabilities:["device_cursor_position"] }]}) }] });
        expect(JSON.parse(output.content[0].text)[0].capabilities).toContain("move");
    });
    it.each([
        ["move", { x: 1, y: 2 }, "display_move"],
        ["drag", { x1: 0, y1: 1, x2: 2, y2: 2, durationMs: 500 }, "display_drag"],
        ["focus_window", { handle: "123" }, "display_focus_window"],
    ])("routes %s and returns only ok", async (name, args, operation) => {
        const result = await call(name as string, { deviceId: "x11-current-display", ...(args as object) });
        expect(result.isError).not.toBe(true);
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0].name).toBe(operation);
    });
    it.each([
        ["drag", { x1: 0, y1: 0, x2: -1, y2: 1 }],
        ["drag", { x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 10001 }],
        ["focus_window", { handle: "1;rm" }], ["focus_window", { handle: "0" }],
        ["focus_window", { handle: "9999999999999999" }],
        ["screenshot", { region: { x: 0, y: 0, width: 0, height: 1 } }],
    ])("rejects malformed %s before dispatch", async (name, args) => {
        expect((await call(name as string, { deviceId: "x11-current-display", ...(args as object) })).isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("composes focus, drag and final cropped observation with a shared target", async () => {
        const region = { x: 1, y: 1, width: 2, height: 1 };
        const result = await call("run_flow", { deviceId: "x11-current-display", steps: [
            { tool: "focus_window", arguments: { handle: "123", implicitBroker: false } },
            { tool: "drag", arguments: { x1: 0, y1: 0, x2: 2, y2: 2, implicitBroker: false } },
            { tool: "screenshot", arguments: { region, implicitBroker: false } },
        ] });
        expect(result.isError).not.toBe(true);
        expect(fixture.calls.map(c => c.name)).toEqual(["display_focus_window", "display_drag", "display_screenshot"]);
        expect(fixture.calls.every(c => c.args.deviceId === "x11-current-display")).toBe(true);
        expect(fixture.calls.at(-1).args).not.toHaveProperty("region");
        const images = result.content.filter((c: any) => c.type === "image");
        expect(images).toHaveLength(1);
        expect(PNG.sync.read(Buffer.from(images[0].data, "base64"))).toMatchObject({ width: 2, height: 1 });
        expect(result.content[0].text).toContain("full-screenshot");
    });
    it("stops after failed focus and does not fabricate a final screen", async () => {
        fixture.fail = "display_focus_window";
        const result = await call("run_flow", { deviceId: "x11-current-display", steps: [
            { tool: "focus_window", arguments: { handle: "123", implicitBroker: false } },
            { tool: "screenshot", arguments: { implicitBroker: false } },
        ] });
        expect(result.isError).toBe(true);
        expect(fixture.calls).toHaveLength(1);
        expect(result.content.some((c: any) => c.type === "image")).toBe(false);
    });
});
