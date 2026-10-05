import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateDeviceLabTestEnvironment } from "../../src/__tests__/helpers/device-lab-test-environment.ts";
import { runWindowsSandboxE2E } from "./windows-sandbox-e2e.ts";
import { realMcpToolRequestTimeoutMs } from "./device-lab-mcp-client.ts";
import { ownerId } from "#device-lab/providers/context.mjs";

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock("./device-lab-mcp-client.ts", async (importOriginal) => ({
    ...await importOriginal<typeof import("./device-lab-mcp-client.ts")>(),
    withDeviceLabMcp: (run: (client: { callTool: typeof callTool }) => Promise<unknown>) => run({ callTool }),
}));

vi.mock("#device-lab/providers/backends/windows-sandbox.mjs", async (importOriginal) => ({
    ...await importOriginal<typeof import("#device-lab/providers/backends/windows-sandbox.mjs")>(),
    windowsDiscovery: () => ({ wsb: null }),
}));

function toolResult(payload: unknown) {
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

describe("Windows Sandbox E2E failed-start cleanup", () => {
    let homeDir: string;
    let restoreEnvironment: () => void;
    let deviceId: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-sandbox-failure-test-"));
        restoreEnvironment = isolateDeviceLabTestEnvironment(homeDir);
        callTool.mockReset();
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
        restoreEnvironment();
    });

    function scenario(startFailure: (id: string) => unknown, cleanupError?: Error) {
        callTool.mockImplementation(async (tool: string, args: { deviceId: string }) => {
            if (tool === "create_windows_sandbox") {
                deviceId = args.deviceId;
                return toolResult({ device: { deviceId, status: "stopped" } });
            }
            if (tool === "devices") return toolResult({ devices: [{ deviceId }] });
            if (tool === "start") return toolResult(startFailure(deviceId));
            if (tool === "stop") {
                if (cleanupError) throw cleanupError;
                return toolResult({ ok: false, error: "missing-provider-metadata", detail: "secret raw provider output" });
            }
            if (tool === "delete") return toolResult({ deleted: deviceId });
            throw new Error(`Unexpected tool ${tool}`);
        });
    }

    it.each([undefined, 240000])("preserves the foreign lock and forwards the configured start budget (%s)", async (timeoutMs) => {
        const lockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
        mkdirSync(join(homeDir, ".ccc/devices/host-locks"), { recursive: true });
        const foreignLock = JSON.stringify({ ownerId: "other-owner", deviceId: "other-device", claimId: "other-claim" });
        writeFileSync(lockPath, foreignLock);
        scenario(id => ({
            ok: false,
            error: "windows-sandbox-host-busy",
            body: {
                error: "windows-sandbox-host-busy",
                plan: { device: { id, backend: "windows-sandbox", status: "stopped" } },
            },
        }));

        await expect(runWindowsSandboxE2E({ brokerOnly: true, failureArtifactRoot: homeDir, timeoutMs }))
            .rejects.toThrow(/^start device: windows-sandbox-host-busy$/);
        const startArgs = callTool.mock.calls.find(([tool]) => tool === "start")![1];
        expect(startArgs).toEqual({ detail: true, deviceId, waitForBoot: true, bootTimeoutMs: timeoutMs ?? 180000 });
        expect(realMcpToolRequestTimeoutMs("start", startArgs)).toBe((timeoutMs ?? 180000) + 30000);
        expect(callTool.mock.calls.map(([tool]) => tool)).toEqual(["create_windows_sandbox", "devices", "start", "delete"]);
        expect(readFileSync(lockPath, "utf8")).toBe(foreignLock);
    });

    it.each([
        { label: "unknown start failure", error: "provider-command-failed", device: (id: string) => ({ id, backend: "windows-sandbox", status: "stopped" }) },
        { label: "mismatched device", error: "windows-sandbox-host-busy", device: () => ({ id: "another-device", backend: "windows-sandbox", status: "stopped" }) },
        { label: "runtime metadata", error: "windows-sandbox-host-busy", device: (id: string) => ({ id, backend: "windows-sandbox", status: "stopped", sandboxId: "12345678-1234-4234-9234-1234567890ab" }) },
    ])("retains both causes and refuses deletion after $label", async ({ error, device }) => {
        scenario(id => ({ ok: false, error, plan: { device: device(id) } }));

        const failure = await runWindowsSandboxE2E({ brokerOnly: true, failureArtifactRoot: homeDir }).catch(error => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.message).toContain(`primary: start device: ${error}`);
        expect(failure.message).toContain("cleanup: Windows Sandbox stop failed");
        expect(failure.message).toContain("missing-provider-metadata");
        expect(failure.message).not.toContain("secret raw provider output");
        expect(failure.errors).toHaveLength(2);
        expect(callTool.mock.calls.map(([tool]) => tool)).toEqual(["create_windows_sandbox", "devices", "start", "stop"]);
    });

    it("bounds terminal diagnostics and omits raw output while retaining a safe artifact reference", async () => {
        const artifact = "results/device-lab-real/mcp-error-12345678-1234-4234-9234-1234567890ab.json";
        const cleanupError = new Error(`Diagnostics: ${artifact}\nC:\\Users\\secret\\password.txt ${"private".repeat(2000)}\u001b[2J`);
        Object.defineProperty(cleanupError, "brokerPayload", { value: {
            error: "missing-provider-metadata", detail: "token=private", stdout: "private command output",
        } });
        scenario(() => ({ ok: false, error: "provider-command-failed", detail: "private".repeat(2000) }), cleanupError);

        const failure = await runWindowsSandboxE2E({ brokerOnly: true, failureArtifactRoot: homeDir }).catch(error => error);
        expect(failure.message).toContain("primary: start device: provider-command-failed");
        expect(failure.message).toContain(`missing-provider-metadata Diagnostics: ${artifact}`);
        expect(failure.message.length).toBeLessThan(1800);
        expect(failure.message).not.toMatch(/private|password|Users|\u001b/);
        expect(failure.errors[1].cause).toBe(cleanupError);
    });

    it.each([false, true])("preserves pre-cleanup logs without interrupting deletion, publication fails=%s", async failPublication => {
        let downloads: string;
        callTool.mockImplementation(async (tool: string, args: { deviceId: string }) => {
            deviceId = args.deviceId || deviceId;
            if (tool === "create_windows_sandbox") {
                downloads = join(homeDir, ".ccc/devices/owners", ownerId(), "windows", deviceId, "downloads");
                mkdirSync(downloads, { recursive: true });
                writeFileSync(join(downloads, "ccc-guest-helper.stderr.txt"), "PRIVATE BEFORE DELETE");
                return toolResult({ device: { deviceId, status: "stopped" } });
            }
            if (tool === "devices") return toolResult({ devices: [{ deviceId }] });
            if (tool === "start") return toolResult({ ok: false, error: "device-start-not-ready" });
            if (tool === "stop") return toolResult({ device: { deviceId, status: "stopped" } });
            if (tool === "delete") { rmSync(downloads, { recursive: true }); return toolResult({ deleted: deviceId }); }
            throw new Error("unexpected tool");
        });
        if (failPublication) writeFileSync(join(homeDir, "results"), "blocked");
        const failure = await runWindowsSandboxE2E({ brokerOnly: true, failureArtifactRoot: homeDir }).catch(error => error);
        expect(failure).toBeInstanceOf(Error);
            expect(failure.message).toContain("start device: device-start-not-ready");
            expect(failure.message).not.toContain("PRIVATE");
            expect(callTool.mock.calls.map(([tool]) => tool)).toEqual(["create_windows_sandbox", "devices", "start", "stop", "delete"]);
            if (failPublication) expect(failure.message).toContain("bootstrap-evidence-capture-failed");
            else {
                const artifact = failure.message.split("Local raw helper logs: ")[1];
                expect(JSON.parse(readFileSync(join(homeDir, artifact), "utf8")).files["ccc-guest-helper.stderr.txt"].text).toBe("PRIVATE BEFORE DELETE");
            }
    });
});
