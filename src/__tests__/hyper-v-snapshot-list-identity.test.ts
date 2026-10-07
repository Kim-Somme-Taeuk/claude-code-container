import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { hyperVVmName, ownershipMarker } from "@ccc/device-lab/host-control/hyper-v/index.js";
import { hyperVSnapshotObservationMismatch } from "@ccc/device-lab/device-lab/broker/hyper-v/snapshots.js";
import { cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const incarnationId = "a".repeat(32);
const diskPath = "C:\\Owned\\OS.vhdx";

describe("snapshot terminal disk identity", () => {
    it.each([
        [diskPath, "c:/owned/os.VHDX", true],
        ["\\\\Server\\Share\\OS.vhdx", "\\\\server\\share\\os.VHDX", true],
        [diskPath, "C:\\other\\OS.vhdx", false],
        [diskPath, "C:\\Owned\\active.avhdx", false],
        [diskPath, "Owned\\OS.vhdx", false],
        ["/fixture/OS.vhdx", "/fixture/os.vhdx", false],
        ["/fixture/OS.vhdx", "/fixture/OS.vhdx", true],
        ["", "", false],
    ])("compares %s against %s without weakening the terminal identity", (expected, actual, valid) => {
        const observation = { ok: true as const, vmId, vmName: "owned", diskPath: actual };
        expect(hyperVSnapshotObservationMismatch(observation, { vmId, vmName: "owned", diskPath: expected }))
            .toBe(valid ? null : "hyper-v-snapshot-disk-identity-mismatch");
    });
});

describe("broker snapshot-list complete VHD observation", () => {
    let scratch: string;
    beforeEach(() => {
        scratch = mkdtempSync(join(tmpdir(), "snapshot-list-broker-"));
        vi.stubEnv("HOME", scratch);
        vi.stubEnv("USERPROFILE", scratch);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(scratch, { recursive: true, force: true });
    });
    it.each(["valid-chain", "foreign-root", "unreadable-active", "unreadable-parent", "unreadable-retry"])("handles %s through the actual broker route", async kind => {
        const cwd = `/project/snapshot-list-${kind}`;
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "snapshot-fixture";
        const vmName = hyperVVmName(ownerId, deviceId, incarnationId);
        let observations = 0;
        // Native client path validation follows this test process's OS. Windows casing is
        // exercised separately above; route coverage uses absolute native fixture paths.
        const expectedDisk = join(scratch, "owned", "os.vhdx");
        const active = join(scratch, "owned", "active.avhdx");
        const terminal = kind === "foreign-root" ? join(scratch, "unrelated", "os.vhdx") : expectedDisk;
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { "powershell.exe": "/fixture/powershell.exe" },
            commandRunner: command => {
                const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8"));
                const request = JSON.parse(envelope.input);
                let items: unknown[] = [];
                if (request.operation === "Get-VM") items = [{ id: vmId, name: vmName,
                    notes: ownershipMarker(ownerId, deviceId, incarnationId), state: "Running", status: "Operating normally",
                    uptimeMilliseconds: 1, generation: 2, checkpointType: "ProductionOnly" }];
                else if (request.operation === "Get-VMHardDiskDrive") {
                    observations++;
                    items = [{ vmId, vmName, path: active, controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskNumber: null }];
                } else if (request.operation === "Get-VHD") {
                    const fail = kind === "unreadable-active" || (kind === "unreadable-parent" && request.path === terminal)
                        || (kind === "unreadable-retry" && observations > 1);
                    if (fail) return { ...command, status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation,
                        ok: false, errorCode: "vhd-metadata-read-failed" }) };
                    items = [{ path: request.path, parentPath: request.path === active ? terminal : null,
                        vhdFormat: "VHDX", vhdType: request.path === active ? "Differencing" : "Dynamic", virtualSizeBytes: 4096, fileSizeBytes: 2048 }];
                } else if (request.operation === "Get-VMSnapshot" && kind === "unreadable-retry") {
                    items = [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: `ccc-${ownerId}-untracked`, vmId, vmName,
                        snapshotType: "Production", parentSnapshotId: null, parentSnapshotName: null, creationTimeMilliseconds: 1 }];
                }
                return { ...command, status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
            },
        });
        const url = await listen(server);
        try {
            writeBrokerDevices(ownerId, "windows-vm", [{ id: deviceId, backend: "windows-vm", status: "running", incarnationId, vmId, vmName, diskPath: expectedDisk }]);
            const response = await fetch(ownerRpcEndpoint(url, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: "device_snapshot_list", deviceId, backend: "windows-vm" } }) });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(kind === "valid-chain" ? 200 : 502);
            if (kind !== "valid-chain") expect(body.detail).toBe(kind === "foreign-root"
                ? "hyper-v-snapshot-disk-identity-mismatch" : "hyper-v-status-vhd-lookup-command-failed");
            if (kind === "unreadable-retry") expect(observations).toBe(2);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });
});
