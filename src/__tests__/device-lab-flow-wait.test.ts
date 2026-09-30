import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the actual public request handler, dispatch, projection and flow serializer;
// replace only transport registration and provider observations to avoid clock races.
const fixture = vi.hoisted(() => ({ handlers: [] as Array<(request: any) => Promise<any>>,
    observations: new Map<string, any>(), calls: [] as string[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../device-lab-mcp/src/backends/android.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleAndroidTool: async (name: string) => {
        fixture.calls.push(publicToolName(name));
        return fixture.observations.get(publicToolName(name)) || { content: [{ type: "text", text: '{"ok":true}' }], isError: false };
    },
}));
vi.mock("../../device-lab-mcp/src/backends/linux-vm.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleLinuxVmManagementTool: async () => null,
    handleLinuxVmTool: async () => null,
}));
import { publicToolName } from "../../device-lab-mcp/src/tools.mjs";
import { startServer } from "../../device-lab-mcp/src/server.mjs";

const wrap = (data: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data) }], isError });
const args = { deviceId: "flow-wait-fixture", implicitBroker: false, text: "needle", packageName: "example.app" };
const action = { tool: "click", arguments: { ...args, x: 1, y: 2 } };
const parse = (result: any) => JSON.parse(result.content[0].text);
async function call(name: string, arguments_: Record<string, unknown>) {
    return fixture.handlers[1]({ params: { name, arguments: arguments_ } });
}
async function flow(name: string, tool: string, detail: boolean, stopOnError?: boolean) {
    return call(name, { detail, ...(stopOnError === undefined ? {} : { stopOnError }),
        steps: [{ tool, label: "condition", arguments: args }, action] });
}

beforeAll(async () => { await startServer(); });
beforeEach(() => { fixture.observations.clear(); fixture.calls.length = 0; });

describe.each(["run_flow"])("%s wait conditions", (name) => {
    it.each([
        ["wait_for_text", { found: false }],
        ["wait_for_app", { found: false }],
        ["wait_for_app", { running: false }],
    ] as const)("stops before the next action for %s %j in compact and detail modes", async (tool, observation) => {
        fixture.observations.set(tool, wrap(observation));
        for (const detail of [false, true]) {
            fixture.calls.length = 0;
            const result = parse(await flow(name, tool, detail));
            expect(result).toMatchObject({ ok: false, stoppedAt: 0, results: [{ tool, isError: true,
                error: "wait-condition-not-met", content: [{ type: "json", value: observation }] }] });
            expect(result.results).toHaveLength(1);
            expect(fixture.calls).toEqual([tool]);
        }
        const standalone = await call(tool, { ...args, detail: false });
        expect(standalone.isError).toBe(false);
        expect(parse(standalone)).toEqual(observation);
    });

    it("continues only when requested, retains all failed observations and overall failure", async () => {
        fixture.observations.set("wait_for_text", wrap({ found: false }));
        fixture.observations.set("wait_for_app", wrap({ running: false }));
        const result = parse(await call(name, { detail: false, stopOnError: false, steps: [
            { tool: "wait_for_text", arguments: args }, action,
            { tool: "wait_for_app", arguments: args },
        ] }));
        expect(result.ok).toBe(false);
        expect(result.stoppedAt).toBeUndefined();
        expect(result.results.map((item: any) => item.isError)).toEqual([true, false, true]);
        expect(fixture.calls).toEqual(["wait_for_text", "click", "wait_for_app"]);
    });

    it.each([
        ["wait_for_text", { found: true }],
        ["wait_for_app", { running: true }],
        ["wait_for_app", { found: true }],
        ["wait_for_text", { result: { found: false }, running: false }],
        ["wait_for_app", { result: { found: false, running: false } }],
        ["get_clipboard", { found: false, running: false, text: "unchanged" }],
        ["wait_for_text", { found: "false" }],
    ] as const)("does not misclassify %s %j", async (tool, observation) => {
        fixture.observations.set(tool, wrap(observation));
        const result = parse(await flow(name, tool, false));
        expect(result.ok).toBe(true);
        expect(result.results.map((item: any) => item.isError)).toEqual([false, false]);
        expect(result.results[0].error).toBeUndefined();
        expect(fixture.calls).toEqual([tool, "click"]);
    });

    it.each([false, true])("retains existing JSON or MCP provider errors (MCP error=%s)", async (isError) => {
        const observation = { ...(isError ? {} : { ok: false }), found: false, error: "transport-unavailable",
            cause: "connection-closed", remedy: "reconnect", cleanup: { complete: false } };
        fixture.observations.set("wait_for_text", wrap(observation, isError));
        const result = parse(await flow(name, "wait_for_text", true));
        expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(result.results[0].error).toBeUndefined();
        expect(result.results[0].content[0].value).toEqual(observation);
        expect(fixture.calls).toEqual(["wait_for_text"]);
    });

    it("retains plain-text provider errors and status failures", async () => {
        fixture.observations.set("wait_for_app", { content: [{ type: "text", text: "Error: process observation failed" }], isError: true });
        const failed = parse(await flow(name, "wait_for_app", false));
        expect(failed.results[0]).toMatchObject({ isError: true, content: [{ type: "json", value: { error: "Error: process observation failed" } }] });
        expect(failed.results[0].error).toBeUndefined();
        fixture.observations.set("automation_status", wrap({ ok: false, error: "session-unavailable" }));
        const status = parse(await flow(name, "automation_status", false));
        expect(status).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(status.results[0].content[0].value.error).toBe("session-unavailable");
    });
});
