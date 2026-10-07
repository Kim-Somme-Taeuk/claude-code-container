import { describe, expect, it } from "vitest";
import { validateDeviceLabToolOutput, type DeviceLabToolOutputMap } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";

describe("usable public observation contracts", () => {
    it.each([
        ["window_list", {}, {}],
        ["window_list", { windows: [{}] }, {}],
        ["window_list", { windows: [{ title: "Editor", handle: 42 }] }, {}],
        ["window_list", { windows: [{ title: "Editor", processId: -1 }] }, {}],
        ["window_list", { windows: [], truncated: "yes" }, {}],
        ["install_app", {}, {}],
        ["install_app", { installed: true }, {}],
        ["launch_app", {}, {}],
        ["launch_app", { launched: " " }, {}],
        ["devices", {}, { view: "available" }],
        ["devices", { backend: "android-emulator" }, { view: "available" }],
        ["devices", { backend: "android-emulator", devices: [{}] }, { view: "available" }],
        ["devices", { backends: [{}] }, { view: "available" }],
        ["devices", { backends: [{ backend: "android-emulator" }] }, { view: "available" }],
        ["devices", { backends: [{ backend: "android-emulator", result: {} }] }, { view: "available" }],
        ["devices", { backends: [], partial: "true" }, { view: "available" }],
        ["snapshot", { snapshots: "baseline" }, { action: "list" }],
        ["snapshot", { snapshots: {} }, { action: "list" }],
    ])("rejects incomplete or mistyped %s responses", (tool, value, args) => {
        expect(() => validateDeviceLabToolOutput(tool as keyof DeviceLabToolOutputMap, value, args as Record<string, unknown>)).toThrow("response contract violation");
    });

    it.each([
        ["window_list", { windows: [] }, {}],
        ["window_list", { windows: [{ title: "", handle: "42", processId: 100 }] }, {}],
        // macOS applications without AXIdentifier still have listable windows.
        ["window_list", { windows: [{ title: "Notes", processName: "Notes", position: [0, 0] }] }, {}],
        ["window_list", { windows: [{ title: "Notes", handle: "macos:100:12345:main" }], truncated: true }, {}],
        ["install_app", { installed: "/project/app.apk", provider: "adb" }, {}],
        ["install_app", { installed: "/project/App.app", udid: "physical-ios", provider: "xcrun-devicectl" }, {}],
        ["launch_app", { launched: "com.example.app", provider: "simctl" }, {}],
        ["launch_app", { launched: "com.example.app/.MainActivity", provider: "adb" }, {}],
        ["launch_app", { launched: "com.example.app", provider: "broker-appium", broker: { ok: true } }, {}],
        ["devices", { backend: "android-emulator", devices: [], hostAvds: [], systemImages: [] }, { view: "available", backend: "android-emulator" }],
        ["devices", { backend: "ios-device", devices: [{ deviceId: "phone" }], hostDevices: [{ udid: "native-candidate" }] }, { view: "available", backend: "ios-device" }],
        ["devices", { backend: "linux-vm", devices: [], discovery: { available: false, missing: ["qemu"] } }, { view: "available" }],
        ["devices", { result: { backend: "windows-vm", devices: [], backends: [{ backend: "windows-vm", devices: [] }] } }, { view: "available", backend: "windows-vm" }],
        ["devices", { backends: [
            { backend: "ios-simulator", devices: [] },
            { backend: "windows-vm", result: { backend: "windows-vm", devices: [] } },
            { backend: "macos-vm", error: "inventory-unavailable", detail: "broker unavailable" },
        ], partial: true }, { view: "available" }],
        ["snapshot", { snapshots: [] }, { action: "list" }],
        ["snapshot", { snapshots: [{ id: "baseline", name: "Baseline" }] }, { action: "list" }],
    ])("accepts actual %s provider variants", (tool, value, args) => {
        expect(validateDeviceLabToolOutput(tool as keyof DeviceLabToolOutputMap, value, args as Record<string, unknown>)).toEqual(value);
    });
});
