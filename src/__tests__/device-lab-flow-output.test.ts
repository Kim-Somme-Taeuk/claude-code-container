import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { flowJsonResult, jsonResult } from "../../device-lab-mcp/src/responses.mjs";
import { compactToolValue } from "../../device-lab-mcp/src/public-output.mjs";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";

function text(result: any): string { return result.content[0].text; }
function value(result: any): any { return JSON.parse(text(result)); }
const evidence = { ok: false, error: "operation-failed", cause: "session-disconnected", remedy: "reconnect session",
    recovery: { retryable: true }, cleanup: { stopped: false, error: "cleanup-failed" }, containment: { isolated: true } };
function step(index: number, isError: boolean, data: unknown, tool = "mobile_wait_for_text") {
    return { index, label: `step-${index}`, tool, isError, content: [{ type: "json", value: data }] };
}

describe("flow output before diagnostic bounds", () => {
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
