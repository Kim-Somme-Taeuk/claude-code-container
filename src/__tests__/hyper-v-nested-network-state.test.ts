import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readDeviceLabStateFile } from "@ccc/device-lab/device-lab-state-file.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("Hyper-V persisted allocations in configured host subnet", () => {
    for (const nested of [false, true]) {
        it(`reads persisted allocations and round-trips the empty state (nested=${nested})`, async () => {
            vi.stubEnv("CCC_HYPER_V_NESTED_HOST", nested ? "1" : "0");
            vi.resetModules();
            const { decodeHyperVNetworkState, encodeHyperVNetworkState } = await import("@ccc/device-lab/device-lab/broker/hyper-v/network-state.js");
            const prefix = nested ? "172.30.0" : "172.29.0";
            const allocation = { ownerId: "0123456789abcdef", deviceId: "nested-fixture", incarnationId: "a".repeat(32),
                address: `${prefix}.141`, macAddress: "02:11:22:33:44:55", allocatedAt: "2026-10-01T00:00:00.000Z" };
            const state = { version: 1, switchName: "CCC Device Lab", switchId: "11111111-2222-3333-4444-555555555555",
                natName: "CCCDeviceLab", prefix: `${prefix}.0/24`, gateway: `${prefix}.1`, managedNat: false,
                allocations: [allocation] };
            const root = mkdtempSync(join(tmpdir(), "nested-network-state-"));
            const file = join(root, "network.json");
            try {
                // Existing disk state from a previous successful allocation must be readable.
                writeFileSync(file, JSON.stringify(state));
                const read = () => readDeviceLabStateFile(file, decodeHyperVNetworkState, "hyper-v-network-state");
                const loaded = read()!;
                expect(loaded.allocations).toEqual([allocation]);
                writeFileSync(file, JSON.stringify(encodeHyperVNetworkState({ ...loaded, allocations: [] })));
                expect(read()!.allocations).toEqual([]);
                for (const address of [nested ? "172.29.0.141" : "172.30.0.141", `${prefix}.0`, `${prefix}.251`, `${prefix}.255`, `${prefix}.0141`, `${prefix}.141'`]) {
                    writeFileSync(file, JSON.stringify({ ...state, allocations: [{ ...allocation, address }] }));
                    expect(read).toThrow("hyper-v-network-state-state-invalid");
                }
            } finally { rmSync(root, { recursive: true, force: true }); }
        });
    }
});
