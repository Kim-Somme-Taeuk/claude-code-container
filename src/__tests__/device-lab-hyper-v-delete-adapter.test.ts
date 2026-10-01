import { describe, expect, it, vi } from "vitest";

import { deleteDeviceLabHyperVVm } from "@ccc/device-lab/device-lab/broker/hyper-v/delete.js";
import type { HyperVWindowsClient } from "@ccc/hyper-v/index.js";

const vmId = "12345678-1234-1234-1234-123456789abc";
const vmName = "ccc-aabbccddeeff0011-test-0123456789abcdef0123456789abcdef";
const notes = "ccc-device-lab:aabbccddeeff0011:test:0123456789abcdef0123456789abcdef";
const deviceRoot = "C:\\ccc\\owners\\aabbccddeeff0011\\test\\artifacts";
const diskPath = `${deviceRoot}\\disks\\root.vhdx`;
const mediaPath = `${deviceRoot}\\disks\\cidata.iso`;
const options = { vmId, vmName, ownershipNotes: notes, deviceRoot, diskPath, auxiliaryMediaPaths: [mediaPath] };

function fixture(overrides: { notes?: string; diskPaths?: string[]; dvdPaths?: string[]; vmId?: string } = {}) {
    let present = true;
    const identity = {
        id: overrides.vmId ?? vmId, name: vmName, notes: overrides.notes ?? notes,
        state: "Running", status: "Operating normally", uptimeMilliseconds: 0,
        generation: 2, checkpointType: "Disabled",
    };
    const getVM = vi.fn(async (selector: { kind: string; id?: string; name?: string }) => present
        && (selector.kind === "id" ? selector.id === identity.id : selector.name === vmName) ? [identity] : []);
    const getVMHardDiskDrives = vi.fn(async () => (overrides.diskPaths ?? [diskPath]).map((path) => ({
        vmId: identity.id, vmName, path, controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskNumber: null,
    })));
    const getVMDvdDrives = vi.fn(async () => (overrides.dvdPaths ?? []).map((path) => ({
        vmId: identity.id, vmName, path, controllerType: "SCSI", controllerNumber: 0, controllerLocation: 1,
    })));
    const removeVM = vi.fn(async () => { present = false; });
    const removeHostFiles = vi.fn(async () => ({ removedCount: 1 }));
    const client = { getVM, getVMHardDiskDrives, getVMDvdDrives, removeVM, removeHostFiles } as unknown as HyperVWindowsClient;
    return { client, getVM, getVMHardDiskDrives, getVMDvdDrives, removeVM, removeHostFiles, setPresent: (value: boolean) => { present = value; } };
}

describe("typed Device Lab Hyper-V deletion", () => {
    it("removes a marked VM with an owned checkpoint disk and proves absence before file cleanup", async () => {
        const host = fixture({ diskPaths: [diskPath, `${deviceRoot}\\disks\\checkpoint.avhdx`], dvdPaths: [mediaPath] });
        const result = await deleteDeviceLabHyperVVm(host.client, options);
        expect(result).toEqual({ vmId, recoveredVm: true, removedDisk: true, alreadyMissing: false });
        expect(host.removeVM).toHaveBeenCalledWith(expect.objectContaining({
            selector: { kind: "id", id: vmId },
            guard: expect.objectContaining({ expectedName: vmName, expectedNotes: notes, ownedDiskDirectory: `${deviceRoot}\\disks` }),
        }));
        expect(host.getVM.mock.invocationCallOrder.at(-1)).toBeLessThan(host.removeHostFiles.mock.invocationCallOrder[0]!);
    });

    it("refuses a foreign attached disk before mutation or cleanup", async () => {
        const host = fixture({ diskPaths: [diskPath, "D:\\foreign\\other.vhdx"] });
        await expect(deleteDeviceLabHyperVVm(host.client, options)).rejects.toThrow("hyper-v-delete-attachment-mismatch");
        expect(host.removeVM).not.toHaveBeenCalled();
        expect(host.removeHostFiles).not.toHaveBeenCalled();
    });

    it("permits an unmarked partial-create VM with only its root disk and expected media", async () => {
        const host = fixture({ notes: "" });
        await deleteDeviceLabHyperVVm(host.client, { ...options, vmId: undefined });
        expect(host.removeVM).toHaveBeenCalledWith(expect.objectContaining({
            guard: expect.objectContaining({ expectedNotes: "", unmarkedRootDiskPath: diskPath }),
        }));
        const withMedia = fixture({ notes: "", dvdPaths: [mediaPath] });
        await deleteDeviceLabHyperVVm(withMedia.client, { ...options, vmId: undefined });
        expect(withMedia.removeVM).toHaveBeenCalledOnce();
        const foreignMedia = fixture({ notes: "", dvdPaths: ["D:\\foreign\\other.iso"] });
        await expect(deleteDeviceLabHyperVVm(foreignMedia.client, { ...options, vmId: undefined }))
            .rejects.toThrow("hyper-v-delete-attachment-mismatch");
        expect(foreignMedia.removeVM).not.toHaveBeenCalled();
    });

    it("does not clean files if a missing GUID has a same-name replacement", async () => {
        const host = fixture({ vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
        await expect(deleteDeviceLabHyperVVm(host.client, options)).rejects.toThrow("hyper-v-delete-vm-ownership-mismatch");
        expect(host.removeVM).not.toHaveBeenCalled();
        expect(host.removeHostFiles).not.toHaveBeenCalled();
    });

    it("treats a lost remove response as successful only after both absence reads", async () => {
        const host = fixture();
        host.removeVM.mockImplementationOnce(async () => { host.setPresent(false); throw new Error("response-lost"); });
        const result = await deleteDeviceLabHyperVVm(host.client, options);
        expect(result.recoveredVm).toBe(true);
        expect(host.removeHostFiles).toHaveBeenCalledTimes(2);
        const stillPresent = fixture();
        stillPresent.removeVM.mockRejectedValueOnce(new Error("response-lost"));
        await expect(deleteDeviceLabHyperVVm(stillPresent.client, options)).rejects.toThrow("response-lost");
        expect(stillPresent.removeHostFiles).not.toHaveBeenCalled();
    });
});
