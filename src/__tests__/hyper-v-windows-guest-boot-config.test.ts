import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsClient,
    type HyperVConfigureVMGuestBootRequest,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionRequest,
} from "../hyper-v-windows/low-level/index.js";

const vmId = "11111111-2222-3333-4444-555555555555";
const request: HyperVConfigureVMGuestBootRequest = {
    selector: { kind: "id", id: vmId.toUpperCase() },
    expectedName: "test-vm",
    expectedNotes: "opaque-owner-marker",
    osDiskPath: "C:\\Hyper-V\\os.vhdx",
    mediaPath: "C:\\Hyper-V\\provision.iso",
    bootSettings: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } },
};

describe("typed Hyper-V guest boot configuration", () => {
    it("sends one exact identity operation with explicit generation policy", async () => {
        const execute = vi.fn(async (sent: HyperVWindowsExecutionRequest, _context: HyperVWindowsExecutionContext) => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: sent.operation, ok: true, items: [] }),
        }));
        const client = createHyperVWindowsClient({ execute });
        await expect(client.configureVMGuestBoot(request)).resolves.toBeUndefined();
        await expect(client.configureVMGuestBoot({
            ...request,
            bootSettings: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        })).resolves.toBeUndefined();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls[0][0]).toEqual({
            schemaVersion: 1,
            operation: "Configure-VMGuestBoot",
            ...request,
            selector: { kind: "id", id: vmId },
        });
        expect(execute.mock.calls[1][0]).toMatchObject({
            operation: "Configure-VMGuestBoot",
            bootSettings: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        });
    });

    it("rejects ambiguous identity, unsafe paths, and invalid settings before native execution", async () => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const invalid: HyperVConfigureVMGuestBootRequest[] = [
            { ...request, selector: { kind: "name", name: "test-vm" } as never },
            { ...request, expectedNotes: "" },
            { ...request, osDiskPath: "relative.vhdx" },
            { ...request, mediaPath: "C:\\media\\[x].iso" },
            { ...request, bootSettings: { generation: 2, secureBoot: { enabled: false } } },
            { ...request, bootSettings: { generation: 1, startupOrder: ["IDE", "IDE"] } },
        ];
        for (const bad of invalid) await expect(client.configureVMGuestBoot(bad)).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });

    it("normalizes Linux bootstrap MAC and sends Secure Boot Off or Gen1 disk-first BIOS policy", async () => {
        const execute = vi.fn(async (sent: HyperVWindowsExecutionRequest) => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: sent.operation, ok: true, items: [] }),
        }));
        const client = createHyperVWindowsClient({ execute });
        const linuxRequest: HyperVConfigureVMGuestBootRequest = {
            ...request,
            guestKind: "linux",
            expectedBootstrapMacAddress: "06:aa:bb:cc:dd:ee",
            bootSettings: { generation: 2, secureBoot: { enabled: false } },
        };
        await client.configureVMGuestBoot(linuxRequest);
        await client.configureVMGuestBoot({
            ...linuxRequest,
            bootSettings: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        });
        expect(execute.mock.calls[0][0]).toMatchObject({
            guestKind: "linux",
            expectedBootstrapMacAddress: "06AABBCCDDEE",
            bootSettings: { generation: 2, secureBoot: { enabled: false } },
        });
        expect(execute.mock.calls[1][0]).toMatchObject({
            guestKind: "linux",
            expectedBootstrapMacAddress: "06AABBCCDDEE",
            bootSettings: { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] },
        });
    });

    it("rejects missing, foreign, or unsafe Linux policy before native execution", async () => {
        const execute = vi.fn(async () => ({ status: 0, stdout: "" }));
        const client = createHyperVWindowsClient({ execute });
        const linuxRequest = {
            ...request,
            guestKind: "linux",
            expectedBootstrapMacAddress: "06AABBCCDDEE",
            bootSettings: { generation: 2, secureBoot: { enabled: false } },
        } as const;
        const invalid = [
            { ...linuxRequest, expectedBootstrapMacAddress: undefined },
            { ...linuxRequest, expectedBootstrapMacAddress: "06-AA-BB-CC-DD-EE" },
            { ...linuxRequest, expectedBootstrapMacAddress: "02AABBCCDDEE" },
            { ...linuxRequest, bootSettings: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } } },
            { ...linuxRequest, bootSettings: { generation: 1, startupOrder: ["CD", "IDE"] } },
            { ...request, expectedBootstrapMacAddress: "06AABBCCDDEE" },
            { ...linuxRequest, guestKind: "other" },
        ];
        for (const bad of invalid) {
            await expect(client.configureVMGuestBoot(bad as HyperVConfigureVMGuestBootRequest))
                .rejects.toMatchObject({ category: "validation" });
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it("rejects success payloads and never replays an uncertain native result", async () => {
        const execute = vi.fn(async () => ({
            status: 0,
            stdout: JSON.stringify({ schemaVersion: 1, operation: "Configure-VMGuestBoot", ok: true, items: [{ path: "C:\\secret" }] }),
        }));
        await expect(createHyperVWindowsClient({ execute }).configureVMGuestBoot(request))
            .rejects.toMatchObject({ category: "protocol", code: "result-ambiguous" });
        expect(execute).toHaveBeenCalledOnce();
    });

    it("does not retry an operation that timed out after it may have attached media", async () => {
        const execute = vi.fn(async () => ({ status: null, stdout: "", timedOut: true }));
        await expect(createHyperVWindowsClient({ execute }).configureVMGuestBoot(request))
            .rejects.toMatchObject({ category: "transport", code: "timeout" });
        expect(execute).toHaveBeenCalledOnce();
    });

    it("fences every mutation behind preflight and reads back postconditions", () => {
        const source = readFileSync(new URL("../../scripts/host-control/hyper-v/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.split('        "Configure-VMGuestBoot" {')[1]?.split('        "Get-VMHardDiskDrive" {')[0] ?? "";
        expect(branch).toContain("hyper-v-guest-provision-vm-identity-mismatch");
        expect(branch).toContain("hyper-v-guest-provision-requires-stopped-vm");
        expect(branch).toContain("$Disks.Count -ne 1");
        expect(branch).toContain("hyper-v-guest-provisioning-media-already-attached");
        expect(branch.indexOf("hyper-v-guest-provisioning-media-already-attached"))
            .toBeLessThan(branch.indexOf("Hyper-V\\Add-VMDvdDrive"));
        expect(branch).toContain("Hyper-V\\Set-VMFirmware");
        expect(branch).toContain("Hyper-V\\Get-VMFirmware");
        expect(branch).toContain("Hyper-V\\Set-VMBios");
        expect(branch).toContain("Hyper-V\\Get-VMBios");
        expect(branch).toContain("Hyper-V\\Enable-VMIntegrationService");
        expect(branch).toContain("$StillDisabled.Count -ne 0");
        expect(branch).toContain("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]");
        expect(branch).toContain("$CleanupVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)");
        expect(branch.indexOf("cleanup-vm-identity-changed"))
            .toBeLessThan(branch.indexOf("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]"));
        expect(branch).toContain("hyper-v-guest-provision-media-cleanup-failed");
        expect(branch).toContain("$FailureCode -cnotin $GuestBootFixedErrorCodes");
        expect(source).toContain('$Operation -eq "Configure-VMGuestBoot" -and $ErrorCode -cnotin $GuestBootFixedErrorCodes');
        expect(branch).not.toContain("$_.Exception.Message | ConvertTo-Json");
    });

    it("rechecks Linux identity and host-wide bootstrap MAC before attach, then preserves integration state", () => {
        const source = readFileSync(new URL("../../scripts/host-control/hyper-v/Invoke-HyperVWindowsOperation.ps1", import.meta.url), "utf8");
        const branch = source.split('        "Configure-VMGuestBoot" {')[1]?.split('        "Get-VMHardDiskDrive" {')[0] ?? "";
        const preAttach = branch.split("$GuestBootStage = \"media-attach\"")[0] ?? "";
        expect(preAttach).toContain("$CurrentVirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)");
        expect(preAttach).toContain("[Guid]$CurrentVirtualMachines[0].Id -ne [Guid][string]$Request.selector.id");
        expect(preAttach).toContain("Hyper-V\\Get-VMNetworkAdapter -VM $VirtualMachine");
        expect(preAttach).toContain("Hyper-V\\Get-VMNetworkAdapter -All");
        expect(preAttach).toContain("$HostBootstrapMacMatches.Count -ne 1");
        expect(preAttach).toContain('$Generation -eq 1 -and [string]$Disks[0].ControllerType -ine "IDE"');
        expect(preAttach.indexOf('$Disks[0].ControllerType -ine "IDE"'))
            .toBeLessThan(branch.indexOf('Hyper-V\\Add-VMDvdDrive'));
        expect(branch).toContain("Hyper-V\\Set-VMFirmware -VM $VirtualMachine -EnableSecureBoot Off -FirstBootDevice $Disks[0]");
        expect(branch).toContain("[string]$Firmware.SecureBoot -cne \"Off\"");
        expect(branch).toContain('if ($GuestKind -ceq "windows") {\n                    $GuestBootStage = "integration-services"');
        expect(branch).toContain('if ($GuestBootMayHaveAttached -and $GuestKind -cne "linux") {');
        expect(branch.indexOf('if ($GuestBootMayHaveAttached -and $GuestKind -cne "linux") {'))
            .toBeLessThan(branch.indexOf("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]"));
        expect(branch).toContain("Hyper-V\\Remove-VMDvdDrive -VMDvdDrive $CleanupAttachments[0]");
    });
});
