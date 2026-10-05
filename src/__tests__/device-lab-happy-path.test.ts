import { describe, expect, it } from "vitest";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { availableDevices, INVENTORY_BACKENDS } from "../../device-lab-mcp/src/available-devices.mjs";
import { normalizePublicToolArgs, toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
const response = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const payload = (result: any) => JSON.parse(result.content[0].text);
describe("normal device journeys", () => {
    it.each([false, true])("returns copyable deviceId across device record boundaries detail=%s", detail => {
        const device = { id: "vm-1", name: "VM", backend: "windows-vm", snapshots: [{ id: "snapshot-1" }] };
        const listed = payload(actionResult("devices", "device_list", response({ devices: [device] }), { detail }));
        const selected = detail ? listed.devices[0] : listed[0];
        expect(selected.deviceId).toBe("vm-1");
        expect(selected).not.toHaveProperty("id");
        for (const [name, operation] of [["create_windows_vm", "device_create"], ["status", "device_status"], ["start", "device_start"]]) {
            const result = payload(actionResult(name, operation, response({ device }), { detail }));
            expect(result.device.deviceId).toBe(selected.deviceId);
            expect(result.device.snapshots[0].id).toBe("snapshot-1");
        }
        expect(payload(actionResult("status", "device_status", response(device), { detail })).deviceId).toBe("vm-1");
    });
    it("normalizes materialized QEMU lab records in detailed lifecycle output", () => {
        const value = payload(actionResult("start", "device_start", response({
            device: { id: "linux-1" }, materialized: { lab: { id: "linux-1", snapshots: [{ id: "snapshot-1" }] } },
        }), { detail: true }));
        expect(value.materialized.lab).toEqual({ deviceId: "linux-1", snapshots: [{ id: "snapshot-1" }] });
    });
    it("keeps device identities copyable on failure in both output modes", () => {
        for (const detail of [false, true]) {
            const failed = actionResult("start", "device_start", response({ ok: false, error: "boot-failed", device: { id: "vm-1" } }), { detail });
            expect(payload(failed).device).toEqual({ deviceId: "vm-1" });
        }
    });
    it.each(["exec", "ui"])("does not rewrite opaque %s data", name => {
        const data = { id: "app", device: { id: "user-data" }, devices: [{ id: "document" }] };
        expect(payload(actionResult(name, name === "exec" ? "device_exec" : "device_accessibility_snapshot", response(data), { detail: true }))).toEqual(data);
    });
    it("defaults to waiting before broker dispatch but preserves explicit false", () => {
        expect(normalizePublicToolArgs("start", { deviceId: "vm" }).waitForBoot).toBe(true);
        expect(normalizePublicToolArgs("start", { deviceId: "vm", waitForBoot: false }).waitForBoot).toBe(false);
    });
    it("accepts aggregate discovery without weakening invalid backend validation", () => {
        expect(toolInputError("devices", { view: "available" })).toBeNull();
        expect(toolInputError("devices", { view: "available", backend: "invalid" })).toBeTruthy();
        expect(toolInputError("devices", { view: "available", backend: "x11-current-display" })).toBeTruthy();
    });
    it("aggregates all inventories in stable order with bounded concurrency", async () => {
        let active = 0, maximum = 0;
        const result = payload(await availableDevices(async (backend: string) => {
            maximum = Math.max(maximum, ++active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active--;
            return response({ backend, devices: [{ id: backend, backend }], hostDevices: [{ serial: "serial-1" }] });
        }));
        expect(maximum).toBe(2);
        expect(result.backends.map((b: any) => b.backend)).toEqual(INVENTORY_BACKENDS);
        expect(result.backends[0].devices[0].deviceId).toBe(INVENTORY_BACKENDS[0]);
        expect(result.backends[0].hostDevices[0].serial).toBe("serial-1");
        expect(result.partial).toBeUndefined();
    });
    it("keeps partial failures distinct from successful empty inventories", async () => {
        const result = payload(await availableDevices(async (backend: string) => {
            if (backend === "android-device") throw new Error("broker-unavailable");
            if (backend === "ios-device") return { ...response({ error: "missing-xcrun" }), isError: true };
            return response({ devices: [], discovery: { available: false, missing: ["prerequisite"] } });
        }));
        expect(result.partial).toBe(true);
        expect(result.backends[1]).toMatchObject({ backend: "android-device", error: "inventory-unavailable", detail: "broker-unavailable" });
        expect(result.backends[3]).toMatchObject({ error: "missing-xcrun" });
        expect(result.backends[0]).toMatchObject({ devices: [], discovery: { available: false, missing: ["prerequisite"] } });
    });
});
