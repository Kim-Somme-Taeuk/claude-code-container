import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", callTool: vi.fn() }));
vi.mock("../../scripts/real-tests/device-lab-mcp-client.ts", async importOriginal => ({
    ...await importOriginal<typeof import("../../scripts/real-tests/device-lab-mcp-client.ts")>(),
    withDeviceLabMcp: async (callback: (client: { callTool: typeof fixture.callTool }) => unknown) =>
        callback({ callTool: fixture.callTool }),
}));
vi.mock("../../scripts/real-tests/helpers.ts", async importOriginal => ({
    ...await importOriginal<typeof import("../../scripts/real-tests/helpers.ts")>(),
    realProviderTempRoot: () => fixture.root,
}));

const { runAndroidEmulatorE2E } = await import("../../scripts/real-tests/android-emulator-e2e.ts");
const payload = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const run = () => runAndroidEmulatorE2E({ brokerOnly: true, systemImage: "system-images;android-35;google_apis;x86_64" });

describe("Android real E2E fixture cleanup", () => {
    let createdId: string;
    beforeEach(() => {
        fixture.root = mkdtempSync(join(tmpdir(), "ccc-e2e-cleanup-test-"));
        fixture.callTool.mockReset();
        createdId = "";
        for (const prefix of ["CCC_REAL_ANDROID_", "CCC_REAL_DEVICE_LAB_ANDROID_"]) {
            for (const suffix of ["APK", "PACKAGE", "PERMISSION"]) vi.stubEnv(`${prefix}${suffix}`, "");
        }
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "device_create") {
                createdId = String(args.deviceId);
                return payload({ device: { id: createdId, port: 5554, provisioned: true } });
            }
            if (tool === "device_inventory") throw new Error("primary-inventory-failure");
            if (tool === "device_stop") return payload({ device: { id: createdId, status: "stopped" } });
            if (tool === "device_delete") return payload({ deleted: createdId, avdDeleted: true });
            throw new Error(`unexpected tool ${tool}`);
        });
    });
    afterEach(() => {
        rmSync(fixture.root, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    const cleanupCalls = () => fixture.callTool.mock.calls.filter(([tool]) => tool === "device_stop" || tool === "device_delete");
    const assertOwnedCleanup = () => {
        expect(cleanupCalls()).toEqual([
            ["device_stop", expect.objectContaining({ backend: "android-emulator", deviceId: createdId })],
            ["device_delete", expect.objectContaining({ backend: "android-emulator", deviceId: createdId,
                force: true, deleteAvd: true, confirmDestructive: true })],
        ]);
        expect(readdirSync(fixture.root)).toEqual([]);
    };

    it("cleans normalized creation without ok after a later failure and preserves that failure", async () => {
        await expect(run()).rejects.toThrow("device_inventory: primary-inventory-failure");
        assertOwnedCleanup();
    });

    it("establishes ownership before validating secondary created-device fields", async () => {
        fixture.callTool.mockImplementationOnce(async (_tool: string, args: Record<string, unknown>) => {
            createdId = String(args.deviceId);
            return payload({ device: { id: createdId, port: "invalid", provisioned: false } });
        });
        await expect(run()).rejects.toThrow("device_create");
        assertOwnedCleanup();
        expect(fixture.callTool.mock.calls.some(([tool]) => tool === "device_inventory")).toBe(false);
    });

    it.each(["mcp-error", "structured-error", "wrong-identity"])("never cleans an unowned fixture after %s creation", async kind => {
        fixture.callTool.mockImplementationOnce(async (_tool: string, args: Record<string, unknown>) => {
            const device = { id: kind === "wrong-identity" ? "unrelated-device" : args.deviceId, port: 5554, provisioned: true };
            return kind === "mcp-error" ? { ...payload({ device, error: "create-failed" }), isError: true }
                : payload({ ...(kind === "structured-error" ? { ok: false, error: "create-failed" } : {}), device });
        });
        await expect(run()).rejects.toThrow("device_create");
        expect(fixture.callTool.mock.calls).toHaveLength(1);
        expect(cleanupCalls()).toEqual([]);
        expect(readdirSync(fixture.root)).toEqual([]);
    });

    it.each(["mcp-error", "structured-error", "throw"])("reports %s stop/delete failures alongside the primary failure and attempts both", async kind => {
        const normal = fixture.callTool.getMockImplementation()!;
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool !== "device_stop" && tool !== "device_delete") return normal(tool, args);
            const error = `${tool}-cleanup-failed`;
            if (kind === "throw") throw new Error(error);
            return { ...payload({ ok: false, error }), ...(kind === "mcp-error" ? { isError: true } : {}) };
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        expect(failure).toContain("primary-inventory-failure");
        expect(failure).toContain("device_stop-cleanup-failed");
        expect(failure).toContain("device_delete-cleanup-failed");
        assertOwnedCleanup();
    });

    it("does not accept successful-looking cleanup replies for a different fixture", async () => {
        const normal = fixture.callTool.getMockImplementation()!;
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "device_stop") return payload({ device: { id: "unrelated-device", status: "stopped" } });
            if (tool === "device_delete") return payload({ deleted: "unrelated-device", avdDeleted: true });
            return normal(tool, args);
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        expect(failure).toContain("primary-inventory-failure");
        expect(failure).toContain("cleanup failed");
        expect(failure).toContain("device stop");
        expect(failure).toContain("device/AVD delete");
        assertOwnedCleanup();
    });
});
