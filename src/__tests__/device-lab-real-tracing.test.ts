import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const fixture = vi.hoisted(() => ({ requests: [] as any[], result: {} as any, tools: [] as any[], closed: 0, cursor: undefined as string | undefined }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
    async connect() {}
    async close() { fixture.closed++; }
    async listTools() { return { tools: fixture.tools, nextCursor: fixture.cursor }; }
    async callTool(request: any) { fixture.requests.push(request); return fixture.result; }
} }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: class {} }));
import { withDeviceLabMcp, consumeDeviceLabMcpToolCalls, markExpectedToolError, markExpectedFlowStepErrors } from "../../scripts/real-tests/device-lab-mcp-client.js";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";

beforeEach(() => {
    fixture.requests = [];
    fixture.tools = structuredClone(TOOLS); fixture.closed = 0; fixture.cursor = undefined;
    fixture.result = { isError: false, content: [{ type: "text", text: "ok" }] };
    consumeDeviceLabMcpToolCalls();
});
describe("real MCP trace matches the wire", () => {
    it.each(["missing", "duplicate", "count", "property", "page"])("refuses %s contracts before callback and closes transport", async change => {
        if (change === "missing") fixture.tools.pop();
        if (change === "duplicate") fixture.tools[0] = fixture.tools[1];
        if (change === "count") delete fixture.tools.find(tool => tool.name === "click").inputSchema.properties.count;
        if (change === "property") fixture.tools[0].inputSchema.properties.description = { type: "string" };
        if (change === "page") fixture.cursor = "next";
        const callback = vi.fn();
        await expect(withDeviceLabMcp(callback)).rejects.toThrow("device-lab-mcp-contract-mismatch");
        expect(callback).not.toHaveBeenCalled();
        expect(fixture.requests).toEqual([]);
        expect(fixture.closed).toBe(1);
    });
    it("accepts equivalent reordered schemas and annotation changes", async () => {
        fixture.tools.reverse();
        for (const tool of fixture.tools) {
            tool.inputSchema = Object.fromEntries(Object.entries(tool.inputSchema).reverse());
            tool.inputSchema.description = "annotation only";
            for (const property of Object.values(tool.inputSchema.properties) as any[]) property.description = "new help";
        }
        const callback = vi.fn();
        await withDeviceLabMcp(callback);
        expect(callback).toHaveBeenCalledOnce();
        expect(fixture.closed).toBe(1);
    });
    it("omits undefined and detaches nested arguments before the asynchronous call", async () => {
        await withDeviceLabMcp(async ({ callTool }) => {
            const args = { name: "vm", port: undefined, nested: { value: "original" }, explicitNull: null };
            const pending = callTool("create_windows_vm", args);
            args.nested.value = "changed";
            await pending;
        });
        const expected = { name: "vm", nested: { value: "original" }, explicitNull: null };
        expect(fixture.requests[0].arguments).toEqual(expected);
        expect(consumeDeviceLabMcpToolCalls()[0].arguments).toEqual(expected);
    });
    it("records failed flow children and requires explicit expected-error markings", async () => {
        fixture.result = { isError: true, content: [{ type: "text", text: JSON.stringify({
            ok: false, error: "flow-step-failed", stoppedAt: 0,
            results: [{ index: 0, tool: "click", isError: true, content: [{ type: "json", value: { error: "device-not-found" } }] }],
        }) }] };
        await withDeviceLabMcp(async ({ callTool }) => {
            const result = await callTool("run_flow", { deviceId: "missing", steps: [{ tool: "click", arguments: { x: 1, y: 1 } }] });
            expect(result.__cccToolCallRecord.expectedError).toBeUndefined();
            expect(result.__cccToolCallRecord.flowSteps).toHaveLength(1);
            expect(result.__cccToolCallRecord.flowSteps[0].expectedError).not.toBe(true);
            markExpectedToolError(result);
            markExpectedFlowStepErrors(result, ["click"]);
        });
        const record = consumeDeviceLabMcpToolCalls()[0];
        expect(record.errorCode).toBe("flow-step-failed");
        expect(record.expectedError).toBe(true);
        expect(record.flowSteps[0]).toMatchObject({ tool: "click", isError: true, expectedError: true, errorCode: "device-not-found" });
    });
    it("excuses only an exact declared input rejection, never arbitrary expected provider errors", () => {
        const dir = mkdtempSync(join(tmpdir(), "ccc-input-proof-"));
        try {
            const fixtureFile = join(dir, "fixture.mjs"), output = join(dir, "summary.json");
            const code = toolInputError("create_android_emulator", { name: "missing-image" });
            const base = { name: "create_android_emulator", arguments: { name: "missing-image" }, outcome: "error-result", isError: true, expectedError: true, errorPayloadJson: true, errorPayloadText: true, errorCode: code };
            const calls = [{ ...base, expectedInputError: code }, { ...base }, { ...base, expectedInputError: code, errorCode: "unrelated-provider-failure" },
                { name: "set_network", arguments: { deviceId: "phone", airplaneMode: false, confirmDestructive: true }, outcome: "ok", isError: false },
                { name: "devices", arguments: { view: "backends" }, outcome: "ok", isError: false },
            ];
            for (const [backend, action] of [
                ["android-device", "usb-tcpip"], ["android-device", "pair"],
                ["android-device", "connect"], ["ios-device", "pair"], ["ios-device", "connect"],
            ]) {
                const args = { backend, action };
                const error = toolInputError("wireless", args);
                expect(error).toBeTruthy();
                calls.push({ name: "wireless", arguments: args, outcome: "error-result", isError: true,
                    expectedError: true, errorPayloadJson: true, errorPayloadText: true,
                    errorCode: error, expectedInputError: error } as any);
            }
            writeFileSync(fixtureFile, `export async function run(){globalThis[Symbol.for('ccc.deviceLabRealTests.toolCalls')]=${JSON.stringify(calls)};return {status:'PASS'}}`);
            const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/real-tests/run.ts"), "--json-summary-file", output, fixtureFile], { encoding: "utf8", timeout: 30000 });
            expect(result.status, result.stderr).toBe(0);
            const coverage = JSON.parse(readFileSync(output, "utf8")).toolCoverage;
            expect(coverage.argumentSchemaFailureRecords).toHaveLength(2);
            expect(coverage.calledArgumentFacets).toEqual(expect.arrayContaining(["set_network:airplaneMode=false", "devices:view=backends"]));
            expect(coverage.calls.slice(0, 3).every((record: any) => record.schemaValid === false)).toBe(true);
            expect(coverage.calls.slice(0, 3).every((record: any) => record.outcome !== "ok")).toBe(true);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
