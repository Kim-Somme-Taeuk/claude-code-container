import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizePublicToolArgs, toolInputError, flowStepArguments } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";

describe("preparation-free public contract", () => {
    it("removes staging tools and helper timeout details from discovery and calls", () => {
        for (const name of ["workspace_sync", "artifacts_export"]) {
            expect(TOOLS.some(t => t.name === name)).toBe(false);
            expect(toolInputError(name, { deviceId: "vm" })).toContain("Unknown tool");
        }
        expect(JSON.stringify(TOOLS)).not.toContain("helperTimeoutMs");
        expect(toolInputError("screenshot", { deviceId: "vm", helperTimeoutMs: 100 })).toContain("timeoutMs");
    });
    it("translates operation deadlines consistently for standalone and flow calls", () => {
        const args = { deviceId: "vm", timeoutMs: 2500 };
        expect(normalizePublicToolArgs("screenshot", args)).toMatchObject({ timeoutMs: 2500, helperTimeoutMs: 2500, rpcTimeoutMs: 32500 });
        const step = flowStepArguments("screenshot", { deviceId: "vm" }, { timeoutMs: 2500 });
        expect(step).toEqual({ deviceId: "vm", timeoutMs: 2500 });
        expect(normalizePublicToolArgs("screenshot", step)).toMatchObject({ deviceId: "vm", helperTimeoutMs: 2500 });
        expect(args).not.toHaveProperty("helperTimeoutMs");
        expect(toolInputError("screenshot", { ...args, timeoutMs: -1 })).toContain("timeoutMs");
        expect(toolInputError("screenshot", { ...args, timeoutMs: 300001 })).toContain("timeoutMs");
    });
    it("keeps full simulator erasure separate from app clearing and retains confirmation", () => {
        expect(toolInputError("reset", { deviceId: "sim", bundleId: "app" })).toContain("clear_app_data");
        const args = normalizePublicToolArgs("reset", { deviceId: "sim" });
        expect(args).toEqual({ deviceId: "sim", eraseSimulator: true });
        expect(evaluateDestructivePolicy("device_reset", args).ok).toBe(false);
        expect(evaluateDestructivePolicy("device_reset", { ...args, confirmDestructive: true }).ok).toBe(true);
        expect(normalizePublicToolArgs("clear_app_data", { deviceId: "sim", bundleId: "app" })).not.toHaveProperty("eraseSimulator");
    });
    it("creates mobile resources without public provisioning switches", () => {
        const android = { backend: "android-emulator", name: "Test", systemImage: "system-images;android-35;google_apis;x86_64" };
        expect(toolInputError("create", android)).toBeNull();
        expect(normalizePublicToolArgs("create", android)).toMatchObject({ createAvd: true });
        const ios = { backend: "ios-simulator", name: "Test", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0" };
        expect(toolInputError("create", ios)).toBeNull();
        expect(normalizePublicToolArgs("create", ios)).toMatchObject({ createSimulator: true });
        expect(toolInputError("create", { ...android, createAvd: true })).toBeTruthy();
        expect(toolInputError("create", { backend: "android-emulator", name: "Test" })).toContain("systemImage");
        expect(toolInputError("create", { backend: "ios-simulator", name: "Test" })).toContain("deviceType");
    });
    it("preserves explicit existing device reuse and rejects cross-platform inputs", () => {
        expect(normalizePublicToolArgs("create", { backend: "android-emulator", name: "Existing", avdName: "existing" })).toMatchObject({ createAvd: false });
        expect(normalizePublicToolArgs("create", { backend: "ios-simulator", name: "Existing", udid: "existing" })).toMatchObject({ createSimulator: false });
        expect(toolInputError("create", { backend: "windows-sandbox", name: "Win", systemImage: "android" })).toBeTruthy();
        expect(toolInputError("create", { backend: "linux-vm", provider: "container-qemu", name: "QEMU", dryRun: true })).toContain("does not support dryRun");
    });
});
