import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";

const validators = new Map(TOOLS.map(tool => [tool.name, new Ajv({ strict: false }).compile(tool.inputSchema)]));
const input = (name: string, args: Record<string, unknown>, valid: boolean) => {
    expect(validators.get(name)!(args), `${name}: ${JSON.stringify(validators.get(name)!.errors)}`).toBe(valid);
    expect(toolInputError(name, args) === null, `${name}: ${toolInputError(name, args)}`).toBe(valid);
};
const payload = (result: any) => JSON.parse(result.content[0].text);

describe("AX requests agree with preflight", () => {
    it("keeps all 59 public tools", () => expect(TOOLS).toHaveLength(59));
    it.each(["delete", "uninstall_app", "clear_app_data", "set_battery"])("%s advertises mandatory true confirmation", name => {
        const args = { deviceId: "phone", ...(name === "set_battery" ? { level: 50 } : {}), ...(["uninstall_app", "clear_app_data"].includes(name) ? { appId: "com.example.app" } : {}) };
        input(name, args, false);
        input(name, { ...args, confirmDestructive: false }, false);
        input(name, { ...args, confirmDestructive: true }, true);
    });
    it("rejects ambiguous selectors before execution", () => {
        input("key", { deviceId: "phone", key: "Enter", keyCode: 3 }, false);
        input("key", { deviceId: "phone", keyCode: 3.5 }, false);
        input("key", { deviceId: "phone", keyCode: 0 }, true);
        input("snapshot", { deviceId: "vm", action: "restore", snapshotName: "a", snapshotId: "b", confirmDestructive: true }, false);
        input("snapshot", { deviceId: "vm", action: "restore", snapshotId: "b", confirmDestructive: true }, true);
    });
    it("describes provider-specific Linux creation", () => {
        input("create_linux_vm", { name: "vm", provider: "container-qemu" }, false);
        input("create_linux_vm", { name: "vm", provider: "container-qemu", baseImageId: "base", sourceImage: "/base.qcow2" }, false);
        input("create_linux_vm", { name: "vm", provider: "container-qemu", baseImageId: "base" }, true);
        input("create_linux_vm", { name: "vm", provider: "container-qemu", baseImageId: "base", dryRun: true }, false);
        input("create_linux_vm", { name: "vm", provider: "hyper-v", cpus: 1.5 }, false);
        input("create_linux_vm", { name: "vm", provider: "hyper-v", ssh: { host: "guest", user: "ccc" } }, false);
    });
    it("advertises wireless action prerequisites", () => {
        input("wireless", { backend: "ios-device", udid: "phone" }, true);
        input("wireless", { backend: "ios-device", action: "pair" }, false);
        input("wireless", { backend: "android-device", action: "pair" }, false);
        input("wireless", { backend: "android-device", action: "pair", pairHost: "10.0.0.2", pairPort: 30000, pairingCode: "123456" }, true);
        input("wireless", { backend: "android-device", action: "usb-tcpip" }, false);
        input("wireless", { backend: "android-device", action: "usb-tcpip", serial: "phone" }, true);
    });
    it("rejects recording fields irrelevant to the selected action", () => {
        input("record_video", { deviceId: "phone", action: "status", timeLimitSec: 30 }, false);
        input("record_video", { deviceId: "phone", action: "stop", remotePath: "/movie.mp4" }, false);
        input("record_video", { deviceId: "phone", action: "status" }, true);
    });
});

describe("AX responses retain decision evidence", () => {
    it.each([false, true])("uses callable wireless next steps in detail=%s", detail => {
        const result = payload(actionResult("wireless", "device_wireless", jsonResult({
            ok: true, backend: "android-device", attachNext: { tool: "device_attach", arguments: { backend: "android-device", connection: "wifi", host: "10.0.0.2", port: 5555 } },
        }), { detail }));
        expect(result.attachNext.tool).toBe("attach");
        expect(validators.get(result.attachNext.tool)!(result.attachNext.arguments)).toBe(true);
    });
    it("keeps the target kind and only actually supported grouped actions", () => {
        const [device] = payload(actionResult("devices", "device_list", jsonResult({ devices: [{
            id: "qa", name: "QA", backend: "macos-vm", provider: "tart", status: "running",
            capabilities: ["device_screenshot", "device_snapshot_create", "device_snapshot_restore"],
        }] })));
        expect(device).toMatchObject({ deviceId: "qa", backend: "macos-vm", provider: "tart" });
        expect(device.capabilities).toContain("screenshot");
        expect(device.supportedActions.snapshot).toEqual(["create", "restore"]);
        expect(device.supportedActions.snapshot).not.toContain("list");
    });
    it.each([false, true])("preserves failure truth with detail=%s", detail => {
        expect(actionResult("click", "device_click", jsonResult({ ok: true, response: { ok: false, error: "no-target" } }), { detail }).isError).toBe(true);
    });
    it.each([false, true])("normalizes app identity and unmet waits with detail=%s", detail => {
        const result = actionResult("wait_for_app", "mobile_wait_for_app", jsonResult({ running: false, packageName: "com.example.app" }), { detail });
        expect(payload(result)).toMatchObject({ matched: false, appId: "com.example.app", reason: "wait-condition-not-met" });
        expect(result.isError).not.toBe(true);
    });
    it("retains bounded recovery and cleanup before bulk diagnostics", () => {
        const result = jsonResult({ ok: false, error: "provider-failed", remedy: "Call status", cleanup: { ok: false, error: "still-running" }, stderr: '\\"\n한'.repeat(70000) });
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(65536);
        expect(payload(result)).toMatchObject({ error: "provider-failed", remedy: "Call status", cleanup: { ok: false, error: "still-running" }, diagnosticTruncated: true });
    });
    it.each([false, true])("bounds newly detected nested action failures in detail=%s", detail => {
        const raw = jsonResult({ ok: true, response: { ok: false, error: "failed", detail: '\\"\n한'.repeat(30000), cleanup: { ok: false, error: "still-running" }, remedy: "Call status" } });
        const result = actionResult("click", "device_click", raw, { detail });
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(65536);
        const value = payload(result);
        expect(value.diagnosticTruncated).toBe(true);
        expect(value.response).toMatchObject({ error: "failed", cleanup: { ok: false, error: "still-running" }, remedy: "Call status" });
    });
});
