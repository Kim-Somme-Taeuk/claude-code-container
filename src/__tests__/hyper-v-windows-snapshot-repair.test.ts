import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsClient,
    type HyperVRepairVMSnapshotStateRequest,
    type HyperVWindowsExecutionRequest,
} from "../hyper-v-windows/low-level/index.js";

const vmId = "12345678-1234-1234-1234-123456789ABC";
const request: HyperVRepairVMSnapshotStateRequest = {
    selector: { kind: "id", id: vmId },
    expectedName: "owned-vm",
    expectedNotes: "opaque-owner-marker",
    snapshotName: "ccc-0123456789abcdef-baseline",
    expectedCheckpointPolicy: "ProductionOnly",
};

function success(items: readonly unknown[]) {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation: "Repair-VMSnapshotState", ok: true, items }),
    };
}

describe("typed Hyper-V snapshot journal repair", () => {
    it("sends one exact owner and policy transaction and decodes its bounded result", async () => {
        const execute = vi.fn(async (_sent: HyperVWindowsExecutionRequest) => success([
            { checkpointPolicy: "ProductionOnly", candidateCount: 1 },
        ]));
        const client = createHyperVWindowsClient({ execute });
        await expect(client.repairVMSnapshotState(request)).resolves.toEqual({
            checkpointPolicy: "ProductionOnly", candidateCount: 1,
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]![0]).toEqual({
            schemaVersion: 1,
            operation: "Repair-VMSnapshotState",
            ...request,
            selector: { kind: "id", id: vmId.toLowerCase() },
        });
    });

    it("rejects invalid targets and policy before native execution", async () => {
        const execute = vi.fn(async () => success([]));
        const client = createHyperVWindowsClient({ execute });
        const invalid = [
            { ...request, selector: { kind: "name", name: "owned-vm" } },
            { ...request, selector: { kind: "id", id: "bad" } },
            { ...request, expectedName: "other*" },
            { ...request, expectedNotes: "" },
            { ...request, snapshotName: "bad?name" },
            { ...request, expectedCheckpointPolicy: "Disabled" },
            { ...request, extra: "unsafe" },
        ];
        for (const bad of invalid) {
            await expect(client.repairVMSnapshotState(bad as HyperVRepairVMSnapshotStateRequest))
                .rejects.toMatchObject({ category: "validation", operation: "Repair-VMSnapshotState" });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it("refuses malformed or ambiguous success without replay", async () => {
        const execute = vi.fn(async () => success([]));
        const client = createHyperVWindowsClient({ execute });
        for (const items of [
            [],
            [{ checkpointPolicy: "Production", candidateCount: 2 }],
            [{ checkpointPolicy: "Disabled", candidateCount: 0 }],
            [{ checkpointPolicy: "Production", candidateCount: 0, path: "C:\\private" }],
            [{ checkpointPolicy: "Production", candidateCount: 0 }, { checkpointPolicy: "Production", candidateCount: 1 }],
        ]) {
            execute.mockImplementationOnce(async () => success(items));
            await expect(client.repairVMSnapshotState(request)).rejects.toMatchObject({ category: "protocol" });
        }
        expect(execute).toHaveBeenCalledTimes(5);
    });

    it("returns bounded native codes and never retries uncertain execution", async () => {
        const execute = vi.fn()
            .mockResolvedValueOnce({ status: 1, stdout: JSON.stringify({
                schemaVersion: 1, operation: "Repair-VMSnapshotState", ok: false,
                errorCode: "hyper-v-snapshot-policy-quarantine-failed",
            }) })
            .mockRejectedValueOnce(new Error("private host path"));
        const client = createHyperVWindowsClient({ execute });
        await expect(client.repairVMSnapshotState(request)).rejects.toMatchObject({
            category: "native", code: "hyper-v-snapshot-policy-quarantine-failed",
        });
        await expect(client.repairVMSnapshotState(request)).rejects.toMatchObject({
            category: "transport", code: "executor-failed",
        });
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it("contains one owner checked policy restore and quarantine sequence", () => {
        const source = readFileSync(new URL("../../scripts/host-control/hyper-v/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.split('        "Repair-VMSnapshotState" {')[1]?.split('        "Get-VMSwitch" {')[0] ?? "";
        expect(branch).toContain('if ([string]$VirtualMachine.CheckpointType -ceq "Disabled")');
        expect(branch.match(/if \(\[string\]\$VirtualMachine.CheckpointType -ceq "Disabled"\)/g)).toHaveLength(2);
        expect(branch).toContain('$VirtualMachine = Assert-HyperVWindowsSnapshotRepairIdentity $Request\n                if ([string]$VirtualMachine.CheckpointType -ceq "Disabled")');
        expect(branch).toContain('Hyper-V\\Set-VM -VM $VirtualMachine -CheckpointType $ExpectedPolicy -ErrorAction Stop');
        expect(branch).toContain('Hyper-V\\Set-VM -VM $VirtualMachine -CheckpointType Disabled -ErrorAction Stop');
        expect(branch).toContain('if ($Candidates.Count -gt 1) { throw "hyper-v-snapshot-reconciliation-ambiguous" }');
        expect(branch).toContain('[string]$_.Name -eq $SnapshotName');
        expect(branch.match(/Assert-HyperVWindowsSnapshotRepairIdentity \$Request/g)).toHaveLength(7);
        expect(branch).not.toContain("Remove-VMSnapshot");
        expect(branch).not.toContain("Restore-VMSnapshot");
    });
});
