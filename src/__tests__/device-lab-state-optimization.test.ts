import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";
import * as leases from "../../device-lab-mcp/src/state/physical-lease-store.mjs";
import { withTargetStatus, withTargetStatuses } from "../../device-lab-mcp/src/status.mjs";
import { mutateOwnerDevices, ownerStateFile, ownerStateMutationLockFile, transitionOwnerDeviceRecord, updateOwnerDevice } from "../../device-lab-mcp/src/state/device-store.mjs";

let home: string;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccc-state-optimization-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
});

function save(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}
function leaseFile(backend: string) {
    return join(home, ".ccc", "devices", "physical-leases", `${backend}.json`);
}
function lease(backend: string, hardwareId: string, overrides = {}) {
    return { backend, hardwareId, ownerId: ownerId(), deviceId: `device-${hardwareId}`, expiresAt: "2999-01-01T00:00:00.000Z", ...overrides };
}
function target(backend: string, hardwareId: string) {
    return { id: `device-${hardwareId}`, backend, hardwareId, physical: true };
}
function identity(file: string) {
    const stat = statSync(file, { bigint: true });
    return { ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size };
}

describe("list-local physical lease snapshots", () => {
    it("reads each physical backend once while preserving owned, expired and foreign lease semantics", () => {
        save(leaseFile("android-device"), { leases: [lease("android-device", "a"), lease("android-device", "b", { expiresAt: "2000-01-01T00:00:00.000Z" }), lease("android-device", "c", { ownerId: "foreign" })] });
        save(leaseFile("ios-device"), { leases: [lease("ios-device", "d")] });
        const read = vi.spyOn(leases, "readPhysicalLeases");
        const targets = [target("android-device", "a"), target("android-device", "b"), target("android-device", "c"), target("ios-device", "d")];
        const result = withTargetStatuses(targets);
        expect(read.mock.calls).toEqual([["android-device"], ["ios-device"]]);
        expect(result.map((item) => item.leaseState.state)).toEqual(["owned", "expired", "missing", "owned"]);
        read.mockClear();
        expect(result).toEqual(targets.map((item) => withTargetStatus(item)));
    });

    it("performs no lease I/O for virtual targets, incomplete identity, empty lists or explicit overrides", () => {
        const read = vi.spyOn(leases, "readPhysicalLeases");
        expect(withTargetStatuses([])).toEqual([]);
        const result = withTargetStatuses([{ id: "virtual", backend: "android" }, { physical: true, backend: "ios-device" }]);
        expect(result.map((item) => item.leaseState.state)).toEqual(["not-required", "unknown"]);
        const override = { state: "provided" };
        expect(withTargetStatuses([target("ios-device", "a")], { leaseState: override })[0].leaseState).toEqual(override);
        expect(read).not.toHaveBeenCalled();
    });

    it("takes a new snapshot on each call and keeps scalar status fresh", () => {
        const file = leaseFile("android-device");
        const item = target("android-device", "a");
        save(file, { leases: [] });
        expect(withTargetStatuses([item, item]).map((entry) => entry.leaseState.state)).toEqual(["missing", "missing"]);
        save(file, { leases: [lease("android-device", "a")] });
        expect(withTargetStatuses([item])[0].leaseState.state).toBe("owned");
        save(file, { leases: [] });
        expect(withTargetStatus(item).leaseState.state).toBe("missing");
    });

    it("fails closed on a corrupt fresh aggregate rather than reusing the previous snapshot", () => {
        const file = leaseFile("ios-device");
        save(file, { leases: [lease("ios-device", "a")] });
        expect(withTargetStatuses([target("ios-device", "a")])[0].leaseState.state).toBe("owned");
        writeFileSync(file, "{broken");
        expect(() => withTargetStatuses([target("ios-device", "a")])).toThrow();
    });
});

describe("validated owner-state no-op mutations", () => {
    it("retains file identity for equal output but still holds the mutation lock while running the updater", () => {
        const file = ownerStateFile("android");
        save(file, { devices: [{ id: "one", lifecycle: "stopped" }] });
        const before = identity(file);
        const updater = vi.fn((devices) => {
            expect(existsSync(ownerStateMutationLockFile("android"))).toBe(true);
            return structuredClone(devices);
        });
        expect(mutateOwnerDevices("android", updater)).toEqual([{ id: "one", lifecycle: "stopped" }]);
        expect(updater).toHaveBeenCalledOnce();
        expect(identity(file)).toEqual(before);
        expect(existsSync(ownerStateMutationLockFile("android"))).toBe(false);
    });

    it("persists in-place mutation instead of mistaking reference equality for no change", () => {
        const file = ownerStateFile("android");
        save(file, { devices: [{ id: "one", lifecycle: "stopped" }] });
        mutateOwnerDevices("android", (devices) => {
            devices[0].lifecycle = "running";
            return devices;
        });
        expect(JSON.parse(readFileSync(file, "utf8")).devices).toEqual([{ id: "one", lifecycle: "running" }]);
    });

    it("rejects unchanged corrupt state before invoking an updater", () => {
        const file = ownerStateFile("android");
        save(file, { devices: [{ id: ".." }] });
        const before = identity(file);
        const updater = vi.fn((devices) => devices);
        expect(() => mutateOwnerDevices("android", updater)).toThrow();
        expect(updater).not.toHaveBeenCalled();
        expect(identity(file)).toEqual(before);
    });

    it("validates invalid in-place output and preserves the existing file", () => {
        const file = ownerStateFile("android");
        save(file, { devices: [{ id: "one" }] });
        const before = identity(file);
        expect(() => mutateOwnerDevices("android", (devices) => { devices[0].id = ".."; return devices; })).toThrow();
        expect(identity(file)).toEqual(before);
        expect(JSON.parse(readFileSync(file, "utf8")).devices).toEqual([{ id: "one" }]);
    });

    it("still creates an initially absent empty state file", () => {
        const file = ownerStateFile("android");
        expect(existsSync(file)).toBe(false);
        expect(mutateOwnerDevices("android", () => [])).toEqual([]);
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ devices: [] });
    });

    it("avoids writes on missing IDs and compare-and-swap mismatch", () => {
        const file = ownerStateFile("android");
        save(file, { devices: [{ id: "one", generation: 2 }] });
        const before = identity(file);
        const updater = vi.fn(() => ({ id: "absent" }));
        expect(updateOwnerDevice("android", "absent", updater)).toBeNull();
        expect(updater).not.toHaveBeenCalled();
        expect(transitionOwnerDeviceRecord("android", "one", { id: "one", generation: 1 }, null)).toMatchObject({ found: true, matched: false });
        expect(transitionOwnerDeviceRecord("android", "absent", {}, null)).toMatchObject({ found: false, matched: false });
        expect(identity(file)).toEqual(before);
    });
});
