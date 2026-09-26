import { isAbsolute, win32 } from "path";

import type { HyperVWindowsClient } from "../../../hyper-v-windows/index.js";

export type DeviceLabHyperVDeleteOptions = {
    readonly vmId?: string;
    readonly vmName: string;
    readonly ownershipNotes: string;
    readonly deviceRoot: string;
    readonly diskPath: string;
    readonly auxiliaryMediaPaths: readonly string[];
};

export type DeviceLabHyperVDeleteResult = {
    readonly vmId: string | null;
    readonly recoveredVm: boolean;
    readonly removedDisk: boolean;
    readonly alreadyMissing: boolean;
};

function pathKey(path: string): string {
    return win32.normalize(path).toLowerCase();
}

function withinDirectory(path: string, directory: string): boolean {
    const relative = win32.relative(directory, path);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${win32.sep}`)
        && !win32.isAbsolute(relative);
}

function validIdentity(options: DeviceLabHyperVDeleteOptions): boolean {
    const diskDirectory = win32.dirname(options.diskPath);
    const absoluteHostPath = (path: string) => win32.isAbsolute(path)
        || (process.platform !== "win32" && isAbsolute(path));
    return options.vmName.length > 0 && options.ownershipNotes.startsWith("ccc-device-lab:")
        && absoluteHostPath(options.deviceRoot) && absoluteHostPath(options.diskPath)
        && options.auxiliaryMediaPaths.every(absoluteHostPath)
        && withinDirectory(options.diskPath, options.deviceRoot)
        && withinDirectory(diskDirectory, options.deviceRoot)
        && options.auxiliaryMediaPaths.every((path) => withinDirectory(path, options.deviceRoot));
}

/** Inspect, remove and prove absence before removing any host files. */
export async function deleteDeviceLabHyperVVm(
    client: HyperVWindowsClient,
    options: DeviceLabHyperVDeleteOptions,
): Promise<DeviceLabHyperVDeleteResult> {
    if (!validIdentity(options)) throw new Error("hyper-v-delete-identity-invalid");
    const expectedId = options.vmId?.toLowerCase();
    const byId = expectedId ? await client.getVM({ kind: "id", id: expectedId }) : [];
    if (byId.length > 1) throw new Error("hyper-v-delete-vm-ambiguous");
    const byName = await client.getVM({ kind: "name", name: options.vmName });
    if (byName.length > 1) throw new Error("hyper-v-delete-vm-ambiguous");
    if (expectedId && byId.length === 0 && byName.length > 0) {
        throw new Error("hyper-v-delete-vm-ownership-mismatch");
    }
    if (byId.length === 1 && (byName.length !== 1 || byName[0].id !== byId[0].id)) {
        throw new Error("hyper-v-delete-vm-ownership-mismatch");
    }
    const vm = byId[0] ?? byName[0];
    let recoveredVm = false;
    if (vm) {
        if (vm.name !== options.vmName || expectedId && vm.id !== expectedId
            || (vm.notes !== options.ownershipNotes && !(vm.notes === "" && !expectedId))) {
            throw new Error("hyper-v-delete-vm-ownership-mismatch");
        }
        const selector = { kind: "id" as const, id: vm.id };
        const [disks, dvds] = await Promise.all([
            client.getVMHardDiskDrives(selector),
            client.getVMDvdDrives(selector),
        ]);
        const diskDirectory = win32.dirname(options.diskPath);
        const expectedDisks = new Set([pathKey(options.diskPath)]);
        const expectedDvds = new Set(options.auxiliaryMediaPaths.map(pathKey));
        if (disks.some((disk) => disk.vmId !== vm.id || disk.vmName !== options.vmName
            || !disk.path || !(expectedDisks.has(pathKey(disk.path))
                || vm.notes !== "" && withinDirectory(disk.path, diskDirectory)))
            || dvds.some((dvd) => dvd.vmId !== vm.id || dvd.vmName !== options.vmName
                || dvd.path && !expectedDvds.has(pathKey(dvd.path)))) {
            throw new Error("hyper-v-delete-attachment-mismatch");
        }
        if (vm.notes === "" && disks.length !== 1) {
            throw new Error("hyper-v-delete-attachment-mismatch");
        }
        try {
            await client.removeVM({
                selector, force: true,
                guard: {
                    expectedName: options.vmName,
                    expectedNotes: vm.notes,
                    expectedDiskPaths: [options.diskPath],
                    ownedDiskDirectory: diskDirectory,
                    expectedDvdPaths: options.auxiliaryMediaPaths,
                    ...(vm.notes === "" ? { unmarkedRootDiskPath: options.diskPath } : {}),
                },
            });
        } catch (cause) {
            // A lost response may follow a successful removal. The two reads below are the only
            // evidence that lets cleanup continue; otherwise retain files and the journal.
            const [remainingById, remainingByName] = await Promise.all([
                client.getVM(selector), client.getVM({ kind: "name", name: options.vmName }),
            ]);
            if (remainingById.length > 0 || remainingByName.length > 0) throw cause;
        }
        recoveredVm = true;
    }
    const [remainingById, remainingByName] = await Promise.all([
        expectedId || vm ? client.getVM({ kind: "id", id: expectedId ?? vm!.id }) : Promise.resolve([]),
        client.getVM({ kind: "name", name: options.vmName }),
    ]);
    if (remainingById.length > 0 || remainingByName.length > 0) {
        throw new Error("hyper-v-delete-absence-unconfirmed");
    }
    const root = await client.removeHostFiles({
        rootDirectory: options.deviceRoot,
        paths: [options.diskPath],
    });
    await client.removeHostFiles({
        rootDirectory: options.deviceRoot,
        paths: options.auxiliaryMediaPaths,
        checkpointDiskDirectory: win32.dirname(options.diskPath),
    });
    return {
        vmId: vm?.id ?? expectedId ?? null,
        recoveredVm,
        removedDisk: root.removedCount > 0,
        alreadyMissing: !vm,
    };
}
