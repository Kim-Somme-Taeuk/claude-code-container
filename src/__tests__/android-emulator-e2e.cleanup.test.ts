import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

    it.each(["mcp-error", "structured-error"])("continues fixture cleanup after %s recording-stop failure", async kind => {
        const normal = fixture.callTool.getMockImplementation()!;
        let uploaded = Buffer.alloc(0);
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, any>) => {
            if (["device_create", "device_stop", "device_delete"].includes(tool)) return normal(tool, args);
            if (tool === "device_inventory") return payload({ devices: [{ id: createdId }] });
            if (tool === "device_start") return payload({ device: { id: createdId, status: "running" }, boot: { ready: true } });
            if (tool === "device_status") return payload({ device: { id: createdId, status: "running" } });
            if (tool === "device_exec") return payload({ stdout: "ccc-adb-e2e-ok" });
            if (tool === "device_upload") {
                uploaded = readFileSync(args.localPath);
                return payload({ provider: "adb", uploaded: { localPath: args.localPath, remotePath: args.remotePath } });
            }
            if (tool === "device_download") {
                writeFileSync(args.localPath, uploaded);
                return payload({ provider: "adb", downloaded: { localPath: args.localPath, remotePath: args.remotePath } });
            }
            if (tool === "mobile_session_status") return payload({ authority: "host-broker", device: { id: createdId } });
            if (tool === "mobile_dump_ui") return payload({ provider: "adb-uiautomator", source: '<node text="Fixture"/>' });
            if (tool === "mobile_wait_for_text") return payload({ provider: "adb-uiautomator", text: args.text, found: true });
            if (tool === "device_record_video_start") return payload({ recording: { provider: "adb-screenrecord", active: true } });
            if (tool === "device_record_video_status") throw new Error("primary-recording-status-failure");
            if (tool === "device_record_video_stop") return {
                ...payload({ ok: false, error: "recording-stop-failed" }),
                ...(kind === "mcp-error" ? { isError: true } : {}),
            };

            const successes: Record<string, unknown> = {
                mobile_home: { status: 0 }, mobile_tap: { status: 0 },
                mobile_double_tap: { doubleTapped: { x: args.x, y: args.y } },
                mobile_long_press: { longPressed: { x: args.x, y: args.y, durationMs: args.durationMs } },
                mobile_swipe: { swiped: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs } },
                mobile_drag: { dragged: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs } },
                mobile_type_text: { typed: true }, mobile_key: { status: 0 },
                mobile_back: { back: true }, mobile_forward: { forward: true }, mobile_recents: { recents: true },
                mobile_lock: { locked: true }, mobile_unlock: { unlocked: true },
                mobile_rotate_left: { orientation: "landscape" }, mobile_rotate_right: { orientation: "reverse-landscape" },
                mobile_set_orientation: { orientation: args.orientation }, mobile_open_url: { openedUrl: args.url },
                mobile_set_location: { provider: "adb-emulator", location: { latitude: args.latitude, longitude: args.longitude, altitude: args.altitude } },
                mobile_set_battery: { battery: { level: args.level, status: args.status, charging: args.charging } },
                device_install_app: { installed: args.path }, mobile_install_app: { installed: args.path },
                device_launch_app: { launched: args.packageName }, mobile_launch_app: { launched: args.packageName },
                mobile_wait_for_app: { packageName: args.packageName, running: true, pid: "1234" },
                mobile_grant_permission: { permission: { packageName: args.packageName, permission: args.permission, action: "grant" } },
                mobile_revoke_permission: { permission: { packageName: args.packageName, permission: args.permission, action: "revoke" } },
                mobile_stop_app: { stopped: args.packageName }, device_reset: { reset: { packageName: args.packageName } },
                mobile_clear_app_data: { reset: { packageName: args.packageName } }, mobile_uninstall_app: { uninstalled: args.packageName },
            };
            if (!(tool in successes)) throw new Error(`unexpected tool before recording: ${tool}`);
            return payload({ provider: "adb", ...(successes[tool] as object) });
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        expect(failure).toContain("device_record_video_status: primary-recording-status-failure");
        expect(failure).toContain("recording stop");
        expect(failure).toContain("recording-stop-failed");
        expect(fixture.callTool.mock.calls.slice(-4).map(([tool]) => tool)).toEqual([
            "device_record_video_status", "device_record_video_stop", "device_stop", "device_delete",
        ]);
        expect(fixture.callTool).toHaveBeenCalledWith("device_record_video_stop", {
            backend: "android-emulator", deviceId: createdId,
        });
        assertOwnedCleanup();
    });
});
