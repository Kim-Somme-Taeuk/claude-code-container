import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as any[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: any) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@ccc/device-lab/providers/backends/android.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    handleAndroidTool: async (name: string, args: unknown) => {
        fixture.calls.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }], isError: false };
    },
}));
vi.mock("@ccc/device-lab/providers/backends/linux-vm.mjs", async original => ({
    ...await original<Record<string, unknown>>(), handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizePublicToolArgs, toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { startServer } from "../../device-lab-mcp/src/server.mjs";
const call = (name: string, args: any) => fixture.handlers[1]({ params: { name, arguments: args } });
beforeAll(async () => { await startServer(); });
beforeEach(() => { fixture.calls.length = 0; });

describe("public execution input stability", () => {
    const booleans = TOOLS.flatMap((tool: any) => Object.entries(tool.inputSchema.properties)
        .filter(([, field]: any) => field.type === "boolean").map(([key]) => [tool.name, key]));
    it.each(booleans)("rejects nonboolean %s.%s before any dispatch", async (name, key) => {
        for (const value of ["false", "true", 0, 1, null, {}, []]) {
            const args = { deviceId: "fixture", name: "fixture", implicitBroker: false, [key]: value };
            expect(toolInputError(name, args)).toMatch(/boolean/);
            const result = await call(name, args);
            expect(result.isError).toBe(true);
            expect(JSON.parse(result.content[0].text).error).toContain(`${key} must be a boolean`);
        }
        expect(fixture.calls).toEqual([]);
    });
    it.each([false, true])("preserves actual deletion booleans %s", async flag => {
        const result = await call("delete", { deviceId: "fixture", implicitBroker: false, confirmDestructive: true, force: flag, deleteAvd: flag });
        expect(result.isError).toBe(false);
        expect(fixture.calls).toEqual([{ name: "device_delete", args: expect.objectContaining({ force: flag, deleteAvd: flag }) }]);
    });
    it("flow rejects an invalid child before provider effects", async () => {
        const result = await call("run_flow", { steps: [{ tool: "click", arguments: { deviceId: "fixture", x: 1, y: 2, detail: "false", implicitBroker: false } }] });
        expect(result.isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it.each(["wait_for_app", "wait_for_text"])("enforces advertised interval bounds for %s", async name => {
        const tool = TOOLS.find((item: any) => item.name === name)!;
        const { minimum, maximum } = tool.inputSchema.properties.intervalMs;
        const args = { deviceId: "fixture", appId: "example.app", text: "ready", implicitBroker: false };
        if (name === "wait_for_text") delete (args as any).appId;
        else delete (args as any).text;
        for (const intervalMs of [0, minimum - 1, maximum + 1, "500", null, NaN, Infinity]) {
            expect(toolInputError(name, { ...args, intervalMs })).toContain("intervalMs");
            expect((await call(name, { ...args, intervalMs })).isError).toBe(true);
        }
        expect(fixture.calls).toEqual([]);
        for (const intervalMs of [minimum, maximum]) expect(toolInputError(name, { ...args, intervalMs })).toBeNull();
    });
    it("passes the advertised exec deadline through the public handler", async () => {
        await call("exec", { deviceId: "fixture", command: "sleep 400", timeoutMs: 600000, implicitBroker: false });
        expect(fixture.calls[0]).toMatchObject({ name: "device_exec", args: { helperTimeoutMs: 600000, rpcTimeoutMs: 630000 } });
        expect(normalizePublicToolArgs("exec", {})).not.toHaveProperty("helperTimeoutMs");
        expect(toolInputError("exec", { deviceId: "fixture", command: "true", timeoutMs: 600001 })).toContain("timeoutMs");
    });
});
