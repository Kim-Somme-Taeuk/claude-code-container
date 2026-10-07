import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { handleAndroidTool } from "../../packages/device-lab/providers/backends/android.mjs";
import { handleAndroidRealTool } from "../../packages/device-lab/providers/backends/android-device.mjs";

const schema = (name: string) => TOOLS.find((tool: any) => tool.name === name)!.inputSchema;

describe("AX follow-up executable input contracts", () => {
    it("retains 59 tools and publishes even Android console port bounds", () => {
        expect(TOOLS).toHaveLength(59);
        expect(schema("create_android_emulator").properties.port).toMatchObject({ type: "integer", minimum: 5554, maximum: 5682, multipleOf: 2 });
    });
    it.each([5553, 5555, 5683, 5684, 5554.5, "5554", null])("rejects Android console port %s before dispatch", (port) => {
        expect(toolInputError("create_android_emulator", { name: "test", avdName: "existing", port })).toMatch(/port/);
    });
    it.each([5554, 5682])("accepts Android console port %s", (port) => {
        expect(toolInputError("create_android_emulator", { name: "test", avdName: "existing", port })).toBeNull();
    });
    it.each([
        { backend: "ios-device" }, { backend: "ios-device", udid: " " },
        { backend: "android-device" }, { backend: "android-device", connection: "usb", host: "phone" },
        { backend: "android-device", connection: "wifi" }, { backend: "android-device", serial: "\0" },
    ])("rejects attach without a usable selector: %j", (args) => {
        expect(toolInputError("attach", args)).toMatch(/requires|nonempty/);
    });
    it.each([
        { backend: "ios-device", udid: "phone-udid" }, { backend: "android-device", serial: "usb-serial" },
        { backend: "android-device", connection: "wifi", host: "192.0.2.1" },
        { backend: "android-device", connection: "wifi", serial: "192.0.2.1:5555" },
    ])("accepts attach selectors: %j", (args) => { expect(toolInputError("attach", args)).toBeNull(); });
    it("advertises conditional selectors and backend recording behavior", () => {
        expect(schema("attach").allOf).toHaveLength(2);
        for (const key of ["serial", "udid", "host"]) expect(schema("attach").properties[key]).toMatchObject({ minLength: 1, description: expect.any(String) });
        const description = TOOLS.find((tool: any) => tool.name === "record_video")!.description;
        expect(description).toContain("Android integer 1..180");
        expect(description).toContain("iOS Simulator ignores it");
        expect(description).toContain("Windows Sandbox and macOS VM use a supplied limit");
        expect(schema("record_video").properties.timeLimitSec.description).toContain("Windows Sandbox and macOS VM use a supplied limit");
        expect(schema("record_video").properties.timeLimitSec.description).not.toContain("ignored by other");
    });
    it.each([0, -1, 1801, 1.5, NaN, Infinity, "180", null])("rejects invalid common recording duration %s before dispatch", (timeLimitSec) => {
        expect(toolInputError("record_video", { deviceId: "target", action: "start", timeLimitSec })).toContain("integer from 1 to 1800");
    });
    it.each([1, 600, 1800])("accepts whole-second common recording duration %s", (timeLimitSec) => {
        expect(toolInputError("record_video", { deviceId: "target", action: "start", timeLimitSec })).toBeNull();
    });
    it("publishes the common recording bounds", () => {
        expect(schema("record_video").properties.timeLimitSec).toMatchObject({ type: "integer", minimum: 1, maximum: 1800 });
    });
    it.each([0, -1, 181, 1.5, NaN, Infinity, "180", null])("rejects Android recording duration %s before target lookup or effects", async (timeLimitSec) => {
        for (const [handler, backend] of [[handleAndroidTool, "android-emulator"], [handleAndroidRealTool, "android-device"]] as const) {
            const result = await handler("device_record_video_start", { backend, deviceId: "absent-ax-duration-target", timeLimitSec });
            expect(result?.isError).toBe(true);
            expect(result?.content[0].text).toContain("integer from 1 to 180");
        }
    });
    it.each([undefined, "macos-vm", "windows-sandbox", "ios-simulator"])("leaves unrelated recording dispatch to its provider (backend %s)", async (backend) => {
        for (const handler of [handleAndroidTool, handleAndroidRealTool]) {
            expect(await handler("device_record_video_start", { backend, deviceId: "absent-non-android-target", timeLimitSec: 600 })).toBeUndefined();
        }
    });
    it("does not let one Android backend validate the other backend", async () => {
        expect(await handleAndroidTool("device_record_video_start", { backend: "android-device", deviceId: "absent-target", timeLimitSec: 600 })).toBeUndefined();
        expect(await handleAndroidRealTool("device_record_video_start", { backend: "android-emulator", deviceId: "absent-target", timeLimitSec: 600 })).toBeUndefined();
    });
    it.each([undefined, 1, 180])("permits Android recording duration %s past the input guard", async (timeLimitSec) => {
        for (const handler of [handleAndroidTool, handleAndroidRealTool]) {
            expect(await handler("device_record_video_start", { deviceId: "absent-ax-duration-target", timeLimitSec })).toBeUndefined();
        }
    });
    it.each([{ level: -1 }, { level: 101 }, { level: 0.5 }, { level: "50" }, { status: 0 }, { status: 6 }, { status: 2.5 }, { charging: 1 }])("rejects invalid battery domain: %j", (state) => {
        expect(toolInputError("set_battery", { deviceId: "android", confirmDestructive: true, ...state })).toMatch(/integer|boolean/);
    });
    it.each([{ level: 0 }, { level: 100 }, { status: 1 }, { status: 5 }, { charging: false }])("accepts battery boundary: %j", (state) => {
        expect(toolInputError("set_battery", { deviceId: "android", confirmDestructive: true, ...state })).toBeNull();
        expect(toolInputError("set_battery", { deviceId: "android", ...state })).toContain("confirmDestructive:true");
    });
    it("publishes battery bounds", () => {
        expect(schema("set_battery").properties.level).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
        expect(schema("set_battery").properties.status).toMatchObject({ type: "integer", minimum: 1, maximum: 5 });
    });
});
