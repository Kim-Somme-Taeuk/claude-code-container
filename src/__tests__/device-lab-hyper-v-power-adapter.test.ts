import { describe, expect, it, vi } from "vitest";

import { executeDeviceLabHyperVPower, hyperVStartCapacityRefusal } from "@ccc/device-lab/device-lab/broker/hyper-v/power.js";
import type { DeviceLabHyperVCommandRunner } from "@ccc/device-lab/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const vmName = "ccc-owned-vm";
const notes = "ccc-device-lab:0123456789abcdef:vm.1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mib = 1024 * 1024;
const host = { totalMemoryBytes: 16 * 1024 * mib, freeMemoryBytes: 8 * 1024 * mib, logicalProcessors: 8 };

function requestOf(command: { input?: string }): HyperVWindowsExecutionRequest {
    const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(memory.input) as HyperVWindowsExecutionRequest;
}

function vm(state: string, overrides: Record<string, unknown> = {}) {
    return { id: vmId, name: vmName, notes, state, status: "Operating normally",
        uptimeMilliseconds: state === "Running" ? 123 : 0, generation: 2, checkpointType: "Production", ...overrides };
}

function harness(initialState: string, finalState = initialState, overrides: {
    readonly first?: Record<string, unknown>;
    readonly last?: Record<string, unknown>;
    readonly failOperation?: string;
    readonly failCode?: string;
    readonly deadlineAfter?: number;
} = {}) {
    const requests: HyperVWindowsExecutionRequest[] = [];
    const run = vi.fn(async (command: { input?: string }) => {
        const request = requestOf(command);
        requests.push(request);
        const failed = request.operation === overrides.failOperation;
        const items = request.operation === "Get-VM"
            ? [vm(requests.filter((value) => value.operation === "Get-VM").length === 1 ? initialState : finalState,
                requests.filter((value) => value.operation === "Get-VM").length === 1 ? overrides.first || {} : overrides.last || {})]
            : [];
        return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation,
            ok: !failed, ...(failed ? { errorCode: overrides.failCode || "native-command-failed" } : { items }) }) };
    });
    const options = {
        executable: "powershell.exe", run: run as DeviceLabHyperVCommandRunner,
        timeoutMilliseconds: () => requests.length >= (overrides.deadlineAfter ?? Infinity) ? 0 : 5000,
        vmId, vmName, expectedNotes: notes, readHostCapacity: () => host,
    };
    return { requests, run, options };
}

describe("Device Lab typed Hyper-V power", () => {
    it("applies available-memory and CPU admission, rather than total-memory admission", () => {
        expect(hyperVStartCapacityRefusal(6144, 2, host)).toBe(null);
        expect(hyperVStartCapacityRefusal(6145, 2, host)).toBe("hyper-v-host-memory-capacity-exceeded");
        expect(hyperVStartCapacityRefusal(1024, 17, host)).toBe("hyper-v-host-cpu-capacity-exceeded");
        expect(hyperVStartCapacityRefusal(1024, 1, { ...host, freeMemoryBytes: -1 }))
            .toBe("hyper-v-host-capacity-inspection-failed");
    });

    it("reports the same sampled memory shortfall without attempting Start-VM", async () => {
        const off = harness("Off");
        let samples = 0;
        const result = await executeDeviceLabHyperVPower({ ...off.options, operation: "start", memoryMb: 6145,
            readHostCapacity: () => { samples++; return host; } });
        expect(result).toEqual({ ok: false, code: "hyper-v-host-memory-capacity-exceeded",
            capacity: { requestedMb: 6145, availableMb: 8192, reserveMb: 2048, shortfallMb: 1 } });
        expect(samples).toBe(1);
        expect(off.requests.map((request) => request.operation)).toEqual(["Get-VM"]);
    });

    it("starts an owned Off VM once and skips capacity and mutation for Running", async () => {
        const off = harness("Off", "Running");
        expect(await executeDeviceLabHyperVPower({ ...off.options, operation: "start", memoryMb: 4096, cpus: 2 }))
            .toEqual({ ok: true, observation: { ok: true, vmId, vmName, state: "Running", status: "Operating normally", uptimeMs: 123 } });
        expect(off.requests.map((request) => request.operation)).toEqual(["Get-VM", "Start-VM", "Get-VM"]);
        expect(off.requests[1]).toEqual(expect.objectContaining({ selector: { kind: "id", id: vmId }, expectedName: vmName, expectedNotes: notes }));

        const running = harness("Running");
        expect((await executeDeviceLabHyperVPower({ ...running.options, operation: "start",
            readHostCapacity: () => { throw new Error("must not read host capacity"); } })).ok).toBe(true);
        expect(running.requests.map((request) => request.operation)).toEqual(["Get-VM", "Get-VM"]);
    });

    it("normal stop requests shutdown with Force, force stop turns off, and Off is a no-op", async () => {
        const normal = harness("Running", "Off");
        expect((await executeDeviceLabHyperVPower({ ...normal.options, operation: "stop" })).ok).toBe(true);
        expect(normal.requests[1]).toEqual(expect.objectContaining({ operation: "Stop-VM", mode: "shutdown", force: true,
            expectedName: vmName, expectedNotes: notes }));
        const forced = harness("Running", "Off");
        expect((await executeDeviceLabHyperVPower({ ...forced.options, operation: "stop", force: true })).ok).toBe(true);
        expect(forced.requests[1]).toEqual(expect.objectContaining({ operation: "Stop-VM", mode: "turn-off", force: true }));
        const off = harness("Off");
        expect((await executeDeviceLabHyperVPower({ ...off.options, operation: "stop" })).ok).toBe(true);
        expect(off.requests.map((request) => request.operation)).toEqual(["Get-VM", "Get-VM"]);
    });

    it("reboots Running with one Restart-VM, starts Off only when allowed, and refuses other states", async () => {
        const running = harness("Running");
        expect((await executeDeviceLabHyperVPower({ ...running.options, operation: "reboot", force: true })).ok).toBe(true);
        expect(running.requests.map((request) => request.operation)).toEqual(["Get-VM", "Restart-VM", "Get-VM"]);
        expect(running.requests[1]).toEqual(expect.objectContaining({ force: true, expectedName: vmName, expectedNotes: notes }));
        const off = harness("Off", "Running");
        expect(await executeDeviceLabHyperVPower({ ...off.options, operation: "reboot" }))
            .toEqual({ ok: false, code: "hyper-v-reboot-requires-running-vm" });
        expect(off.requests).toHaveLength(1);
        const offAllowed = harness("Off", "Running");
        expect((await executeDeviceLabHyperVPower({ ...offAllowed.options, operation: "reboot", startIfStopped: true,
            readHostCapacity: () => { throw new Error("Off reboot does not check capacity"); } })).ok).toBe(true);
        expect(offAllowed.requests.map((request) => request.operation)).toEqual(["Get-VM", "Start-VM", "Get-VM"]);
        const paused = harness("Paused");
        expect(await executeDeviceLabHyperVPower({ ...paused.options, operation: "reboot", startIfStopped: true }))
            .toEqual({ ok: false, code: "hyper-v-reboot-invalid-state" });
    });

    it("fails closed on wrong identity before mutation and on changed identity after mutation", async () => {
        const wrong = harness("Off", "Running", { first: { notes: "foreign" } });
        expect(await executeDeviceLabHyperVPower({ ...wrong.options, operation: "start" }))
            .toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        expect(wrong.requests.map((request) => request.operation)).toEqual(["Get-VM"]);
        const changed = harness("Off", "Running", { last: { notes: "foreign" } });
        expect(await executeDeviceLabHyperVPower({ ...changed.options, operation: "start" }))
            .toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        expect(changed.requests.map((request) => request.operation)).toEqual(["Get-VM", "Start-VM", "Get-VM"]);
    });

    it("maps native identity refusal and post-mutation deadline to fixed codes", async () => {
        const native = harness("Running", "Off", { failOperation: "Stop-VM", failCode: "vm-identity-mismatch" });
        expect(await executeDeviceLabHyperVPower({ ...native.options, operation: "stop" }))
            .toEqual({ ok: false, code: "hyper-v-vm-ownership-mismatch" });
        const deadline = harness("Off", "Running", { deadlineAfter: 2 });
        expect(await executeDeviceLabHyperVPower({ ...deadline.options, operation: "start" }))
            .toEqual({ ok: false, code: "hyper-v-lifecycle-timeout" });
        expect(deadline.requests.map((request) => request.operation)).toEqual(["Get-VM", "Start-VM"]);
    });
});
