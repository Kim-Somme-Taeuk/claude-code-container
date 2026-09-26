import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import { createHyperVWindowsClient, parseHyperVWindowsGuestBootDiagnostic, type HyperVWindowsExecutionContext, type HyperVWindowsExecutionRequest } from "../hyper-v-windows/index.js";

const vmId = "11111111-2222-3333-4444-555555555555";
const identity = { selector: { kind: "id" as const, id: vmId }, expectedName: "ccc-vm", expectedNotes: "opaque-owner-marker" };

function diagnostic() {
    return {
        ok: true, vmId, vmName: "ccc-vm", state: "Running", uptimeMs: 1200,
        generation: 2, secureBootEnabled: true, heartbeatEnabled: true,
        heartbeatPrimaryStatus: 2, heartbeatSecondaryStatus: 0,
        integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
        hardDiskCount: 12, dvdCount: 2, hardDiskControllers: ["scsi"],
        bootDeviceTypes: ["hard-disk", "dvd"],
        bootEntries: [{ bootType: "Drive", deviceType: "Vhd", controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0 }],
        hardDisks: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 0, vhdFormat: "VHDX", vhdType: "Dynamic", sizeBytes: 34359738368, fileSizeBytes: 4294967296, minimumSizeBytes: 3221225472, logicalSectorSize: 512, physicalSectorSize: 4096 }],
        dvdDrives: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 1, mediaAttached: true }],
        diagnosticComplete: true, diagnosticErrors: [],
    };
}

describe("typed Hyper-V boot diagnostic", () => {
    it("sends one exact identity read within the requested deadline", async () => {
        const execute = vi.fn(async (request: HyperVWindowsExecutionRequest, _context: HyperVWindowsExecutionContext) => ({
            status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [diagnostic()] }),
        }));
        const result = await createHyperVWindowsClient({ execute }).getVMDiagnostic(identity, { timeoutMilliseconds: 1200 });
        expect(result).toEqual(diagnostic());
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0]).toEqual({ schemaVersion: 1, operation: "Get-VMDiagnostic", ...identity });
        expect(execute.mock.calls[0][1]).toEqual(expect.objectContaining({ timeoutMilliseconds: 1200 }));
    });

    it("rejects mismatched identity before a native call and a mismatched response afterward", async () => {
        const execute = vi.fn(async (request: HyperVWindowsExecutionRequest, _context: HyperVWindowsExecutionContext) => ({
            status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [{ ...diagnostic(), vmName: "other" }] }),
        }));
        const client = createHyperVWindowsClient({ execute });
        await expect(client.getVMDiagnostic({ ...identity, selector: { kind: "name", name: "ccc-vm" } as never })).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
        await expect(client.getVMDiagnostic(identity)).rejects.toMatchObject({ category: "protocol", code: "result-identity-mismatch" });
    });

    it("keeps valid partial evidence and rejects paths, unbounded arrays and native text", () => {
        const partial = { ...diagnostic(), diagnosticComplete: false, diagnosticErrors: ["hyper-v-diagnostic-vhd-inspection-incomplete"] };
        expect(parseHyperVWindowsGuestBootDiagnostic(partial)?.state).toBe("Running");
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, diskPath: "C:\\private\\secret.vhdx" })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, integrationServices: Array.from({ length: 17 }, () => partial.integrationServices[0]) })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, diagnosticErrors: ["C:\\private\\secret.vhdx"] })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, hardDisks: [{ ...partial.hardDisks[0], vhdFormat: "C:\\secret" }] })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, bootEntries: [{ ...partial.bootEntries[0], controllerType: "C:\\secret" }] })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, hardDisks: [{ ...partial.hardDisks[0], controllerType: ["scsi"] }] })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, dvdDrives: [{ ...partial.dvdDrives[0], controllerType: ["scsi"] }] })).toBeNull();
        expect(parseHyperVWindowsGuestBootDiagnostic({ ...partial, hardDiskCount: 5000 })).toBeNull();
    });

    it("fences native readers after identity and retains independent partial sections", () => {
        const source = readFileSync(new URL("../../scripts/host-control/hyper-v/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.slice(source.indexOf('"Get-VMDiagnostic" {'));
        expect(branch.indexOf("diagnostic-vm-identity-mismatch")).toBeLessThan(branch.indexOf("Get-HyperVWindowsGuestBootDiagnosticResult -Vm"));
        for (const code of [
            "hyper-v-diagnostic-integration-services-unavailable",
            "hyper-v-diagnostic-firmware-unavailable",
            "hyper-v-diagnostic-bios-unavailable",
            "hyper-v-diagnostic-hard-disks-unavailable",
            "hyper-v-diagnostic-vhd-inspection-incomplete",
            "hyper-v-diagnostic-dvd-drives-unavailable",
        ]) expect(source).toContain(code);
        expect(source).toContain("84eaae65-2f2e-45f5-9bb5-0e857dc8eb47");
        expect(source).toContain("Hyper-V\\Get-VMIntegrationService");
    });
});
