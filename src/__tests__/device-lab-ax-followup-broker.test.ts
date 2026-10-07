import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

describe("host broker AX follow-up contracts", () => {
    let testHome: string;
    beforeEach(() => {
        testHome = mkdtempSync(join(tmpdir(), "ccc-ax-broker-home-"));
        vi.stubEnv("HOME", testHome);
        vi.stubEnv("USERPROFILE", testHome);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(testHome, { recursive: true, force: true });
    });
    it("discovers copyable installed Android images and profiles before a first device exists", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-broker-sdk-"));
        const owner = deviceLabOwnerId(root);
        const manager = join(root, "cmdline-tools", "latest", "bin", "avdmanager");
        const disk = join(root, "system-images", "android-35", "google_apis", "x86_64", "system.img");
        for (const path of [manager, disk]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture"); }
        const run = vi.fn((command: any) => ({ ...command, status: 0, stdout: 'id: 0 or "pixel_6"\n', stderr: "" }));
        const server = createDeviceBrokerServer({ cwd: root, providerPaths: { avdmanager: manager }, commandRunner: run });
        try {
            const response = await fetch(ownerRpcEndpoint(await listen(server), owner), {
                method: "POST", headers: ownerRpcHeaders(owner),
                body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: "device_inventory", backend: "android-emulator" } }),
            });
            expect(response.status).toBe(200);
            expect((await response.json()).result).toMatchObject({ devices: [],
                systemImages: ["system-images;android-35;google_apis;x86_64"], deviceProfiles: ["pixel_6"],
            });
            expect(run).toHaveBeenCalledTimes(1);
            expect(run).toHaveBeenCalledWith(expect.objectContaining({ provider: "avdmanager", args: ["list", "device"] }), { timeoutMs: 5000, outputLimit: 262144 });
        } finally { await close(server); cleanupOwner(owner); rmSync(root, { recursive: true, force: true }); }
    });
    it.each(["android-emulator", "android-device"])("rejects unsupported recording durations before provider commands for %s", async backend => {
        const root = mkdtempSync(join(tmpdir(), "ccc-broker-limit-"));
        const owner = deviceLabOwnerId(root);
        const run = vi.fn((command: any) => ({ ...command, status: 0, stdout: "", stderr: "" }));
        const server = createDeviceBrokerServer({ cwd: root, commandRunner: run });
        try {
            writeBrokerDevices(owner, backend === "android-emulator" ? "android" : "android-device", [{ id: "phone", backend, port: 5580, serial: "SERIAL", status: "running" }]);
            const url = ownerRpcEndpoint(await listen(server), owner);
            for (const timeLimitSec of [0, -1, 0.5, 1801, "5", 181, 1800]) {
                const response = await fetch(url, { method: "POST", headers: ownerRpcHeaders(owner),
                    body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: "device_record_video_start", deviceId: "phone", timeLimitSec } }),
                });
                expect(response.status).toBe(400);
                expect((await response.json()).error).toMatch(/recording-time-limit-invalid/);
            }
            expect(run).not.toHaveBeenCalled();
        } finally { await close(server); cleanupOwner(owner); rmSync(root, { recursive: true, force: true }); }
    });
});
