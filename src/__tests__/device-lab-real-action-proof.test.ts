import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { summarizeToolResultForProof, createTargetBackendEvidence } from "../../scripts/real-tests/device-lab-mcp-client.js";

const proof = (text: string) => summarizeToolResultForProof({ content: [{ type: "text", text }], isError: false });
describe("literal action success proof", () => {
    it("recognizes only the exact action success text", () => {
        expect(proof("ok").okPayloadAction).toBe(true);
        for (const text of ["OK", "ok\n", "completed", "{\"ok\":true}"]) expect(proof(text).okPayloadAction).toBeUndefined();
    });
    it("accepts literal ok only for declared simple actions, including flow steps", () => {
        const dir = mkdtempSync(join(tmpdir(), "ccc-action-proof-"));
        try {
            const file = join(dir, "fixture.mjs"), summary = join(dir, "summary.json");
            const calls = [
                { name: "click", arguments: { deviceId: "x11-current-display", x: 1, y: 1 }, ...proof("ok") },
                { name: "devices", arguments: {}, ...proof("[]") },
                { name: "status", arguments: { deviceId: "x11-current-display" }, ...proof("ok") },
                { name: "type", arguments: { deviceId: "x11-current-display", text: "hello" }, ...proof("completed") },
                { name: "run_flow", arguments: { steps: [{ tool: "click", arguments: { deviceId: "x11-current-display", x: 1, y: 1 } }] },
                    ...proof('{"ok":true,"results":[]}'), flowSteps: [
                        { tool: "click", isError: false, okPayloadAction: true },
                        { tool: "status", isError: false, okPayloadAction: true },
                    ] },
            ].map(call => ({ ...call, outcome: "ok", isError: false }));
            writeFileSync(file, `export async function run(){globalThis[Symbol.for('ccc.deviceLabRealTests.toolCalls')]=${JSON.stringify(calls)};return {status:'PASS'}}`);
            const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/real-tests/run.ts"), "--json-summary-file", summary, file], { encoding: "utf8", timeout: 30000 });
            expect(result.status, result.stderr).toBe(0);
            const coverage = JSON.parse(readFileSync(summary, "utf8")).toolCoverage;
            expect(coverage.argumentSchemaFailureRecords).toEqual([]);
            expect(coverage.emptyOkPublicPayloadRecords).toEqual([]);
            expect(coverage.okPublicPayloadFailures.map((record: any) => record.tool)).toEqual(["status", "type"]);
            expect(coverage.okPublicFlowStepPayloadFailures.map((record: any) => record.tool)).toEqual(["status"]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});


describe("provider proof from owned device identity", () => {
    const result = (value: unknown, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(value) }] });
    it("credits a later ID-only action only after a successful owned identity observation", () => {
        const evidence = createTargetBackendEvidence();
        const args = { deviceId: "owned-vm" };
        expect(evidence.observe("click", args, result("ok"))).toBeUndefined();
        evidence.observe("devices", { view: "available", backend: "windows-vm" }, result({ devices: [{ deviceId: "owned-vm" }] }));
        expect(evidence.observe("click", args, result("ok"))).toBe("windows-vm");
        expect(evidence.observe("click", { deviceId: "other" }, result("ok"))).toBeUndefined();
        evidence.observe("devices", {}, result({ result: { backends: [{ stateKey: "linux-vm", devices: [{ deviceId: "host-owned" }] }] } }));
        expect(evidence.lookup("host-owned")).toBe("linux-vm");
        evidence.observe("devices", {}, result({ result: { backends: [{ stateKey: "android", devices: [{ deviceId: "pixel" }] }, { stateKey: "ios-device", devices: [{ deviceId: "owned-iphone" }] }, { stateKey: "ios-device", error: "failed", devices: [{ deviceId: "iphone" }] }] } }));
        expect(evidence.lookup("pixel")).toBe("android-emulator");
        expect(evidence.lookup("owned-iphone")).toBe("ios-device");
        expect(evidence.lookup("iphone")).toBeUndefined();
        expect(evidence.observe("click", args, result({ error: "failed" }, true))).toBeUndefined();
    });
    it("rejects failed inventories, arbitrary backend arguments and conflicting identities", () => {
        const evidence = createTargetBackendEvidence();
        evidence.observe("devices", { view: "available", backend: "windows-vm" }, result({ devices: [{ deviceId: "owned" }] }, true));
        expect(evidence.lookup("owned")).toBeUndefined();
        evidence.observe("exec", { deviceId: "owned" }, result({ result: { deviceId: "owned", backend: "windows-vm" } }));
        expect(evidence.lookup("owned")).toBeUndefined();
        evidence.observe("click", { backend: "windows-vm", deviceId: "owned" }, result({ deviceId: "owned" }));
        expect(evidence.lookup("owned")).toBeUndefined();
        evidence.observe("status", { deviceId: "owned" }, result({ device: { deviceId: "owned", backend: "windows-vm" } }));
        expect(evidence.lookup("owned")).toBe("windows-vm");
        evidence.observe("status", { deviceId: "owned" }, result({ device: { deviceId: "owned", backend: "linux-vm" } }));
        expect(evidence.lookup("owned")).toBeUndefined();
    });
});
