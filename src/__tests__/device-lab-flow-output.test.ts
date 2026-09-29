import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { flowJsonResult, jsonResult } from "../../device-lab-mcp/src/responses.mjs";
import { compactToolValue } from "../../device-lab-mcp/src/public-output.mjs";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";

// Exercise the real handler/flow/serializer with only provider observations and
// transport registration replaced. Stdio fixture children remain unmocked.
const nativeFixture = vi.hoisted(() => ({ handlers: [] as Array<(request: any) => Promise<any>>, result: {} as any, calls: 0, throwOnCall: 0 }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) { nativeFixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../device-lab-mcp/src/backends/android.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleAndroidTool: async () => {
        nativeFixture.calls++;
        if (nativeFixture.calls === nativeFixture.throwOnCall) throw new Error("provider-disconnected");
        return structuredClone(nativeFixture.result);
    },
}));
vi.mock("../../device-lab-mcp/src/backends/linux-vm.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    handleLinuxVmManagementTool: async () => null, handleLinuxVmTool: async () => null,
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
beforeAll(async () => { await startServer(); });

function text(result: any): string { return result.content[0].text; }
function value(result: any): any { return JSON.parse(text(result)); }
const evidence = { ok: false, error: "operation-failed", cause: "session-disconnected", remedy: "reconnect session",
    recovery: { retryable: true }, cleanup: { stopped: false, error: "cleanup-failed" }, containment: { isolated: true } };
function step(index: number, isError: boolean, data: unknown, tool = "mobile_wait_for_text") {
    return { index, label: `step-${index}`, tool, isError, content: [{ type: "json", value: data }] };
}

describe("flow output before diagnostic bounds", () => {
    it.each(["device_run_flow", "mobile_run_flow"])("returns two inspectable screenshots in one real stdio %s call", async (name) => {
        const context = await createFakeAndroidMcpContext();
        try {
            const created = value(await context.client.callTool({ name: "device_create", arguments: {
                backend: "android-emulator", name: "Flow images", avdName: "Flow", port: 5582,
            } }));
            const screenshot = { tool: "device_screenshot", arguments: { deviceId: created.device.id, implicitBroker: false } };
            for (const detail of [false, true]) {
                const response: any = await context.client.callTool({ name, arguments: { detail, steps: [screenshot, screenshot] } });
                expect(response.isError).toBe(false);
                expect(response.content.slice(1)).toHaveLength(2);
                for (const item of response.content.slice(1)) {
                    expect(item).toMatchObject({ type: "image", mimeType: "image/png" });
                    expect(Buffer.from(item.data, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
                }
                expect(value(response).results).toMatchObject([{ contentIndex: 1, contentCount: 1 }, { contentIndex: 2, contentCount: 1 }]);
                expect(text(response)).not.toContain(response.content[1].data);
            }
            expect(readFileSync(context.logPath, "utf8").split("exec-out screencap -p").length - 1).toBe(4);
        } finally { await cleanupFakeAndroidMcpContext(context); }
    });

    it.each([
        ["mobile_run_flow", false], ["mobile_run_flow", true],
        ["device_run_flow", false], ["device_run_flow", true],
    ] as const)("bounds malformed metadata over public MCP %s (detail=%s)", async (name, detail) => {
        const context = await createDeviceLabMcpTestContext();
        try {
            const payload = "x".repeat(70000);
            for (const label of [{ payload }, [payload]]) {
                const result = await context.client.callTool({ name, arguments: { detail, steps: [
                    { tool: "mobile_key", label, arguments: {} },
                ] } });
                expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(65536);
                expect(value(result)).toMatchObject({ ok: false, stoppedAt: 0, results: [
                    { index: 0, tool: "mobile_key", label: "mobile_key", isError: true },
                ] });
                expect(text(result)).toContain("mobile_key requires key or keyCode");
            }
            for (const malformed of [{ payload }, [payload]]) {
                for (const field of ["tool", "name"]) {
                    const result = await context.client.callTool({ name, arguments: { detail, stopOnError: false, steps: [
                        { tool: "mobile_key", label: "prior failure", arguments: {} },
                        { [field]: malformed, label: { payload } },
                    ] } });
                    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(65536);
                    expect(value(result)).toMatchObject({ ok: false, results: [
                        { index: 0, tool: "mobile_key", label: "prior failure", isError: true },
                        { index: 1, label: "step-2", isError: true, error: "Flow step requires tool or name" },
                    ] });
                    expect(text(result)).toContain("mobile_key requires key or keyCode");
                }
            }
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });

    it.each(["mobile_run_flow", "device_run_flow"])("preserves the later failure over public MCP %s", { timeout: 30000 }, async (name) => {
        const context = await createFakeAndroidMcpContext();
        try {
            const adb = join(context.binDir, "adb");
            writeFileSync(adb, readFileSync(adb, "utf8").replaceAll(
                "printf '%s\\n' '<hierarchy><node text=\"Hello\" resource-id=\"com.example:id/title\"/></hierarchy>'",
                '/bin/cat "$HOME/flow-ui.xml"'));
            const created = value(await context.client.callTool({ name: "device_create", arguments: {
                backend: "android-emulator", name: "Flow", avdName: "Flow", port: 5582,
            } }));
            const deviceId = created.device.id;
            const steps = [
                { tool: "mobile_wait_for_text", label: "large observation", arguments: { deviceId, text: "Hello", implicitBroker: false, timeoutMs: 1000 } },
                { tool: "mobile_key", label: "actual failure", arguments: { deviceId, implicitBroker: false } },
            ];
            writeFileSync(join(context.homeDir, "flow-ui.xml"), `<hierarchy><node text="Hello"/>${"x".repeat(70000)}</hierarchy>`);
            const compact = await context.client.callTool({ name, arguments: { detail: false, steps } });
            const parsed = value(compact);
            expect(parsed).toMatchObject({ ok: false, stoppedAt: 1, results: [
                { index: 0, label: "large observation", tool: "mobile_wait_for_text", isError: false },
                { index: 1, label: "actual failure", tool: "mobile_key", isError: true },
            ] });
            expect(text(compact)).toContain("mobile_key requires key or keyCode");
            expect(parsed.results[0].content[0].value.source).toBeUndefined();
            expect(Buffer.byteLength(text(compact))).toBeLessThan(2000);
            const detailed = value(await context.client.callTool({ name, arguments: { detail: true, steps } }));
            expect(detailed).toMatchObject({ ok: false, stoppedAt: 1, diagnosticTruncated: true });
            expect(detailed.results[0].content[0]).toMatchObject({ omitted: true, diagnosticTruncated: true });
            expect(detailed.results[0].content[0].originalBytes).toBeGreaterThan(70000);
            expect(JSON.stringify(detailed.results[1])).toContain("mobile_key requires key or keyCode");
            const smallSource = '<hierarchy><node text="Hello"/></hierarchy>';
            writeFileSync(join(context.homeDir, "flow-ui.xml"), smallSource);
            const small = value(await context.client.callTool({ name, arguments: { detail: true, steps } }));
            expect(small.results[0].content[0].value.source).toContain(smallSource);
            expect(small.diagnosticTruncated).toBeUndefined();
            const continued = value(await context.client.callTool({ name, arguments: {
                detail: false, stopOnError: false, steps: [...steps, { tool: "mobile_wait_for_text", arguments: { deviceId } }],
            } }));
            expect(continued.ok).toBe(false);
            expect(continued.stoppedAt).toBeUndefined();
            expect(continued.results.map((item: any) => item.isError)).toEqual([false, true, true]);
            expect(JSON.stringify(continued.results[2])).toContain("mobile_wait_for_text requires text");
        } finally { await cleanupFakeAndroidMcpContext(context); }
    });

    it("keeps in-bounds detail exact and compact projection preserves failure evidence", () => {
        const original = { ok: false, stoppedAt: 1, results: [step(0, false, { matched: true, source: "raw hierarchy" }), step(1, true, evidence)] };
        expect(value(flowJsonResult(original, { detail: true }))).toEqual(original);
        const compact = value(flowJsonResult(compactToolValue("mobile_run_flow", original)));
        expect(compact.results[0].content[0].value.source).toBeUndefined();
        expect(compact.results[1].content[0].value).toEqual(evidence);
    });

    it("omits oversized successful content explicitly while retaining small failure and artifact evidence", () => {
        const images = [{ type: "image", mimeType: "image/png", bytes: 1200 }, { type: "resource", uri: "file:///capture.xml", mimeType: "text/xml" }];
        const original = { ok: false, stoppedAt: 1, results: [
            { ...step(0, false, { source: "x".repeat(70000) }), content: [...step(0, false, { source: "x".repeat(70000) }).content, ...images] },
            step(1, true, evidence),
        ] };
        const result = flowJsonResult(original, { detail: true });
        expect(result.isError).toBe(true);
        const parsed = value(result);
        expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(65536);
        expect(parsed).toMatchObject({ ok: false, stoppedAt: 1, diagnosticTruncated: true, maxBytes: 65536 });
        expect(parsed.originalBytes).toBeGreaterThan(70000);
        expect(parsed.results[0].content[0]).toMatchObject({ omitted: true, diagnosticTruncated: true });
        expect(parsed.results[0].content.slice(1)).toEqual(images);
        expect(parsed.results[1].content[0].value).toEqual(evidence);
    });

    it.each([false, true])("bounds 50 escaped Unicode failures and huge labels (detail=%s)", (detail) => {
        const huge = '\u0000"\\😀漢字'.repeat(12000);
        const original = { ok: false, results: Array.from({ length: 50 }, (_, index) => ({
            ...step(index, true, { ...evidence, error: `failure-${index}`, stdout: huge }), label: `label-${index}-${huge}`,
        })) };
        const result = flowJsonResult(original, { detail });
        expect(result.isError).toBe(true);
        const parsed = value(result);
        expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(65536);
        expect(parsed.results).toHaveLength(50);
        expect(parsed.diagnosticTruncated).toBe(true);
        parsed.results.forEach((item: any, index: number) => {
            expect(item).toMatchObject({ index, isError: true, tool: "mobile_wait_for_text" });
            expect(item.label).toContain(`label-${index}`);
            expect(item.labelTruncated.originalBytes).toBeGreaterThan(65536);
            expect(item.content[0].diagnosticTruncated).toBe(true);
            expect(item.content[0].originalBytes).toBeGreaterThan(65536);
            expect(JSON.stringify(item.content)).toContain(`failure-${index}`);
        });
    });

    it("leaves the general jsonResult failure bound unchanged", () => {
        const parsed = value(jsonResult({ ok: false, error: "standalone", source: "x".repeat(70000) }));
        expect(parsed).toMatchObject({ ok: false, error: "standalone", diagnosticTruncated: true, maxBytes: 65536 });
        expect(parsed.source).toBeUndefined();
    });
});

const nativeImage = { type: "image", mimeType: "image/png", data: "aW1hZ2U=", annotations: { audience: ["assistant"] } };
const nativeBlocks = [nativeImage, nativeImage,
    { type: "resource", resource: { uri: "file:///capture.xml", mimeType: "text/xml", text: "<ui/>" } },
    { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
    { type: "resource_link", uri: "file:///capture.png", name: "capture", mimeType: "image/png" },
];
const nativeStep = { tool: "mobile_tap", arguments: { deviceId: "native-flow", implicitBroker: false, x: 1, y: 2 } };
function nativeCall(name: string, args: Record<string, unknown>) {
    return nativeFixture.handlers[1]({ params: { name, arguments: args } });
}

describe.each(["device_run_flow", "mobile_run_flow"])("%s native observations", (name) => {
    it("retains prior images when the next provider throws", async () => {
        nativeFixture.calls = 0;
        nativeFixture.throwOnCall = 2;
        nativeFixture.result = { content: [nativeImage], isError: false };
        try {
            const result = await nativeCall(name, { steps: [nativeStep, nativeStep, nativeStep] });
            expect(result.isError).toBe(true);
            expect(value(result).stoppedAt).toBe(1);
            expect(value(result).results[1].content[0].text).toContain("provider-disconnected");
            expect(result.content.slice(1)).toEqual([nativeImage]);
            expect(nativeFixture.calls).toBe(2);
        } finally { nativeFixture.throwOnCall = 0; }
    });

    it.each([false, true])("preserves ordered native occurrences and references (detail=%s)", async (detail) => {
        nativeFixture.calls = 0;
        nativeFixture.result = { isError: false, content: [nativeBlocks[0], { type: "text", text: '{"ok":true,"value":"observation"}' }, ...nativeBlocks.slice(1)] };
        const original = structuredClone(nativeFixture.result);
        const result = await nativeCall(name, { detail, steps: [nativeStep, nativeStep] });
        expect(result.isError).toBe(false);
        expect(nativeFixture.calls).toBe(2);
        expect(result.content.slice(1)).toEqual([...nativeBlocks, ...nativeBlocks]);
        expect(value(result).results).toMatchObject([
            { contentIndex: 1, contentCount: 5, content: [{ type: "json", value: { value: "observation" } }] },
            { contentIndex: 6, contentCount: 5 },
        ]);
        expect(text(result)).not.toContain(nativeImage.data);
        expect(nativeFixture.result).toEqual(original);
    });

    it.each([false, true])("retains prior observations when a later input is invalid (continue=%s)", async (continueOnError) => {
        nativeFixture.result = { content: [nativeImage], isError: false };
        const result = await nativeCall(name, { stopOnError: !continueOnError, steps: [nativeStep, { tool: "mobile_key", arguments: {} }, nativeStep] });
        expect(result.isError).toBe(true);
        expect(value(result).ok).toBe(false);
        expect(result.content.slice(1)).toEqual(continueOnError ? [nativeImage, nativeImage] : [nativeImage]);
        expect(value(result).results[0]).toMatchObject({ contentIndex: 1, contentCount: 1 });
        if (continueOnError) expect(value(result).results[2]).toMatchObject({ contentIndex: 2, contentCount: 1 });
        else expect(value(result).stoppedAt).toBe(1);
    });

    it.each([false, true])("keeps references and errors through large failed JSON bounds (detail=%s)", async (detail) => {
        nativeFixture.result = { isError: true, content: [
            { type: "text", text: JSON.stringify({ ok: false, error: "native-step-failed", cleanup: { stopped: false }, diagnostic: '\u0000"\\😀漢字'.repeat(12000) }) },
            ...nativeBlocks,
        ] };
        const result = await nativeCall(name, { detail, stopOnError: false, steps: Array.from({ length: 50 }, () => ({ ...nativeStep, label: "😀".repeat(18000) })) });
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(65536);
        const parsed = value(result);
        expect(parsed.ok).toBe(false);
        expect(parsed.results).toHaveLength(50);
        expect(result.content).toHaveLength(251);
        parsed.results.forEach((entry: any, index: number) => {
            expect(entry).toMatchObject({ contentIndex: 1 + index * 5, contentCount: 5, isError: true });
            expect(result.content.slice(entry.contentIndex, entry.contentIndex + entry.contentCount)).toEqual(nativeBlocks);
            expect(JSON.stringify(entry.content)).toContain("native-step-failed");
        });
        expect(text(result)).not.toContain(nativeImage.data);
    });

    it("omits native references for text-only results and marks an unmet wait as a flow error", async () => {
        nativeFixture.result = { isError: false, content: [{ type: "text", text: '{"found":false}' }] };
        const result = await nativeCall(name, { steps: [{ tool: "mobile_wait_for_text", arguments: { ...nativeStep.arguments, text: "needle" } }, nativeStep] });
        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(value(result).results[0]).not.toHaveProperty("contentIndex");
        expect(value(result).results[0].error).toBe("wait-condition-not-met");
        expect(value(result).results).toHaveLength(1);
    });
});
