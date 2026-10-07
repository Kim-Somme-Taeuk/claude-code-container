import { describe, expect, it, vi } from "vitest";

import {
    createDeviceLabHyperVSnapshot,
    deleteDeviceLabHyperVSnapshot,
    hyperVSnapshotInventoryConflict,
    settleHyperVSnapshotInventory,
    repairDeviceLabHyperVSnapshotState,
    resolveOwnedHyperVSnapshot,
    restoreDeviceLabHyperVSnapshot,
} from "@ccc/device-lab/device-lab/broker/hyper-v/snapshots.js";
import type {
    HyperVVirtualMachine,
    HyperVVirtualMachineSnapshot,
    HyperVWindowsClient,
} from "@ccc/hyper-v/index.js";

const vmId = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
const snapshotId = "11111111-2222-3333-4444-555555555555";
const foreignSnapshotId = "99999999-8888-7777-6666-555555555555";
const providerName = "ccc-0123456789abcdef-nightly";

function snapshot(overrides: Partial<HyperVVirtualMachineSnapshot> = {}): HyperVVirtualMachineSnapshot {
    return {
        id: snapshotId,
        name: providerName,
        vmId,
        vmName: "ccc-0123456789abcdef-windows-ci-01",
        snapshotType: "Production",
        parentSnapshotId: null,
        parentSnapshotName: null,
        creationTimeMilliseconds: 1_700_000_000_000,
        ...overrides,
    };
}

function machine(state: string): HyperVVirtualMachine {
    return {
        id: vmId,
        name: "ccc-0123456789abcdef-windows-ci-01",
        state,
        status: "Operating normally",
        notes: "ccc-device-lab",
        uptimeMilliseconds: 0,
        generation: 2,
        checkpointType: "ProductionOnly",
    };
}

function client(overrides: Partial<HyperVWindowsClient> = {}): HyperVWindowsClient {
    return {
        getVM: vi.fn(async () => [machine("Off")]),
        getVMHardDiskDrives: vi.fn(async () => []),
        getVMDvdDrives: vi.fn(async () => []),
        startVM: vi.fn(async () => undefined),
        stopVM: vi.fn(async () => undefined),
        removeVM: vi.fn(async () => undefined),
        getVMSnapshots: vi.fn(async () => [snapshot()]),
        checkpointVM: vi.fn(async () => snapshot()),
        removeVMSnapshot: vi.fn(async () => undefined),
        restoreVMSnapshot: vi.fn(async () => undefined),
        repairVMSnapshotState: vi.fn(async () => ({ checkpointPolicy: "ProductionOnly" as const, candidateCount: 1 as const })),
        ...overrides,
    } as HyperVWindowsClient;
}

describe("Device Lab Hyper-V snapshot adapter", () => {
    it("classifies exact owner inventory drift without accepting a changed checkpoint ID", () => {
        const tracked = [{ id: snapshotId, name: "nightly", providerName }];
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", tracked, [
            { snapshotId: snapshotId.toUpperCase(), snapshotName: providerName },
        ])).toEqual({ untracked: [], missing: [] });
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", tracked, [
            { snapshotId: foreignSnapshotId, snapshotName: providerName },
        ])).toEqual({
            untracked: [{ id: foreignSnapshotId, providerName }],
            missing: [{ id: snapshotId, name: "nightly" }],
        });
        expect(hyperVSnapshotInventoryConflict("0123456789abcdef", [], [
            { snapshotId: foreignSnapshotId, snapshotName: providerName.toUpperCase() },
        ]).untracked).toHaveLength(1);
    });

    it("re-observes a transient mismatch but keeps a stable conflict and read failures", async () => {
        const tracked = [{ id: snapshotId, name: "nightly", providerName }];
        const wrong = [{ snapshotId: foreignSnapshotId, snapshotName: providerName }];
        const exact = [{ snapshotId, snapshotName: providerName }];
        const readSettled = vi.fn(async () => ({ ok: true as const, snapshots: exact }));
        const limits = { deadlineAt: Number.POSITIVE_INFINITY, timeoutError: "timeout", delayMilliseconds: 0 };
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readSettled, limits))
            .toEqual({ ok: true, conflict: { untracked: [], missing: [] } });
        expect(readSettled).toHaveBeenCalledTimes(1);

        const readStable = vi.fn(async () => ({ ok: true as const, snapshots: wrong }));
        const stable = await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readStable, limits);
        expect(stable.ok && stable.conflict.untracked).toHaveLength(1);
        expect(stable.ok && stable.conflict.missing).toHaveLength(1);
        expect(readStable).toHaveBeenCalledTimes(2);

        const readFailed = vi.fn(async () => ({ ok: false as const, error: "provider-read-failed" }));
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readFailed, limits))
            .toEqual({ ok: false, error: "provider-read-failed" });
        expect(await settleHyperVSnapshotInventory("0123456789abcdef", tracked, wrong, readSettled,
            { deadlineAt: Date.now() - 1, timeoutError: "timeout", delayMilliseconds: 0 }))
            .toEqual({ ok: false, error: "timeout" });
        expect(readSettled).toHaveBeenCalledTimes(1);
    });

    it("passes owner identity and journal policy to one typed repair transaction", async () => {
        const repairVMSnapshotState = vi.fn(async () => ({ checkpointPolicy: "ProductionOnly" as const, candidateCount: 1 as const }));
        const repaired = await repairDeviceLabHyperVSnapshotState(client({ repairVMSnapshotState }), {
            vmId,
            vmName: "ccc-0123456789abcdef-windows-ci-01",
            expectedNotes: "ccc-device-lab:0123456789abcdef:windows-ci-01:11111111111111111111111111111111",
            providerName,
            expectedCheckpointPolicy: "ProductionOnly",
        });
        expect(repairVMSnapshotState).toHaveBeenCalledTimes(1);
        expect(repairVMSnapshotState).toHaveBeenCalledWith({
            selector: { kind: "id", id: vmId },
            expectedName: "ccc-0123456789abcdef-windows-ci-01",
            expectedNotes: "ccc-device-lab:0123456789abcdef:windows-ci-01:11111111111111111111111111111111",
            snapshotName: providerName,
            expectedCheckpointPolicy: "ProductionOnly",
        });
        expect(repaired).toEqual({ checkpointPolicy: "ProductionOnly", candidateCount: 1 });
    });

    it("keeps owner-scoped naming and ownership fencing out of the library", async () => {
        const created = await createDeviceLabHyperVSnapshot(client(), { vmId, providerName });
        expect(created).toEqual({
            ok: true,
            snapshotId,
            snapshotName: providerName,
            snapshotType: "Production",
        });
    });

    it("waits for the exact created checkpoint before publishing its id", async () => {
        const stages: string[] = [];
        const getVMSnapshots = vi.fn()
            .mockImplementationOnce(async () => { stages.push("read"); return []; })
            .mockImplementationOnce(async () => [snapshot()]);
        const created = await createDeviceLabHyperVSnapshot(client({ getVMSnapshots }),
            { vmId, providerName }, { confirmationTimeoutMilliseconds: 1000, confirmationDelayMilliseconds: 0,
                onCreatedId: (id) => { expect(id).toBe(snapshotId); stages.push("journal"); } });
        expect(created.snapshotId).toBe(snapshotId);
        expect(getVMSnapshots).toHaveBeenCalledTimes(2);
        expect(stages).toEqual(["journal", "read"]);
    });

    it("does not publish a checkpoint that remains absent or reappears with another id", async () => {
        await expect(createDeviceLabHyperVSnapshot(client({ getVMSnapshots: vi.fn(async () => []) }),
            { vmId, providerName }, { confirmationTimeoutMilliseconds: 1, confirmationDelayMilliseconds: 1 }))
            .rejects.toThrow("hyper-v-snapshot-create-unconfirmed");
        await expect(createDeviceLabHyperVSnapshot(client({
            getVMSnapshots: vi.fn(async () => [snapshot({ id: foreignSnapshotId })]),
        }), { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-create-identity-conflict");
        await expect(createDeviceLabHyperVSnapshot(client({
            getVMSnapshots: vi.fn(async () => [snapshot(), snapshot({ id: foreignSnapshotId })]),
        }), { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-create-identity-conflict");
    });

    // Distinct from the ownership fence: the checkpoint was already created, so this is an
    // untrustworthy result rather than drift, and the broker answers it without reconciliation.
    it("refuses a checkpoint the host named differently", async () => {
        const renamed = client({ checkpointVM: vi.fn(async () => snapshot({ name: "someone-elses" })) });
        await expect(createDeviceLabHyperVSnapshot(renamed, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-result-mismatch");
    });

    it("resolves exactly one owned checkpoint by provider name", async () => {
        const resolved = await resolveOwnedHyperVSnapshot(client(), { vmId, providerName });
        expect(resolved.id).toBe(snapshotId);
    });

    it("refuses when no checkpoint carries the owner-scoped name", async () => {
        const foreign = client({ getVMSnapshots: vi.fn(async () => [snapshot({ name: "unrelated" })]) });
        await expect(resolveOwnedHyperVSnapshot(foreign, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("refuses when the tracked id does not match the named checkpoint", async () => {
        await expect(resolveOwnedHyperVSnapshot(client(), { vmId, providerName, snapshotId: foreignSnapshotId }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("refuses an ambiguous owner-scoped name", async () => {
        const ambiguous = client({
            getVMSnapshots: vi.fn(async () => [snapshot(), snapshot({ id: foreignSnapshotId })]),
        });
        await expect(resolveOwnedHyperVSnapshot(ambiguous, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-ownership-mismatch");
    });

    it("refuses to report a delete the host did not actually perform", async () => {
        // Remove-VMSnapshot reports success but the checkpoint is still there on the follow-up read.
        const stubborn = client({ getVMSnapshots: vi.fn(async () => [snapshot()]) });
        await expect(deleteDeviceLabHyperVSnapshot(stubborn, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-delete-unconfirmed");
    });

    it("deletes the resolved checkpoint by id and reports it deleted", async () => {
        const removeVMSnapshot = vi.fn(async () => undefined);
        const reads = [[snapshot()], []];
        const deleted = await deleteDeviceLabHyperVSnapshot(
            client({ removeVMSnapshot, getVMSnapshots: vi.fn(async () => reads.shift() ?? []) }),
            { vmId, providerName },
        );
        expect(removeVMSnapshot).toHaveBeenCalledWith(
            { selector: { kind: "id", id: vmId }, snapshot: { kind: "id", id: snapshotId } },
            undefined,
        );
        expect(deleted).toEqual({
            ok: true,
            snapshotId,
            snapshotName: providerName,
            snapshotType: "Production",
            deleted: true,
        });
    });

    it("refuses to restore a running VM unless forced", async () => {
        const running = client({ getVM: vi.fn(async () => [machine("Running")]) });
        await expect(restoreDeviceLabHyperVSnapshot(running, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-restore-requires-stopped-vm");
        expect(running.restoreVMSnapshot).not.toHaveBeenCalled();
    });

    it("turns off a running VM before a forced restore", async () => {
        const stopVM = vi.fn(async () => undefined);
        const running = client({ getVM: vi.fn(async () => [machine("Running")]), stopVM });
        await restoreDeviceLabHyperVSnapshot(running, { vmId, providerName }, { force: true });
        expect(stopVM).toHaveBeenCalledWith(
            { selector: { kind: "id", id: vmId }, mode: "turn-off", force: true },
            undefined,
        );
        expect(running.restoreVMSnapshot).toHaveBeenCalled();
    });

    it("starts the VM after restore only when asked, and reports the settled state", async () => {
        const states = ["Off", "Off", "Running"];
        const startVM = vi.fn(async () => undefined);
        const started = client({
            getVM: vi.fn(async () => [machine(states.shift() ?? "Running")]),
            startVM,
        });
        const restored = await restoreDeviceLabHyperVSnapshot(
            started,
            { vmId, providerName },
            { startAfterRestore: true },
        );
        expect(startVM).toHaveBeenCalledTimes(1);
        expect(restored.state).toBe("Running");
    });

    it("leaves the VM off when start-after-restore is not requested", async () => {
        const startVM = vi.fn(async () => undefined);
        const restored = await restoreDeviceLabHyperVSnapshot(client({ startVM }), { vmId, providerName });
        expect(startVM).not.toHaveBeenCalled();
        expect(restored.state).toBe("Off");
    });

    it("refuses when the VM selector does not resolve exactly one machine", async () => {
        const missing = client({ getVM: vi.fn(async () => []) });
        await expect(restoreDeviceLabHyperVSnapshot(missing, { vmId, providerName }))
            .rejects.toThrow("hyper-v-snapshot-vm-ownership-mismatch");
    });
});
