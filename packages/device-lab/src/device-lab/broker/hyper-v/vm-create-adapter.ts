import { win32 } from "path";

import {
    planHyperVVirtualMachineCreation,
    type HyperVCreateEffect,
    type HyperVCreateVirtualMachineRequest,
} from "@ccc/hyper-v/lifecycle/index.js";
import {
    parseHyperVMacAddress,
    parseHyperVVirtualSwitchName,
    type HyperVWindowsClient,
    type HyperVWindowsNetworkClient,
} from "@ccc/hyper-v/low-level/index.js";
import { assertHyperVOperationDeadline } from "./deadline.js";

type CreateVmClient = Pick<HyperVWindowsClient,
    "getVM" | "getVMHardDiskDrives" | "newVM" | "setVM" | "setVMMemory"
    | "setVMProcessor" | "getVMFirmware" | "getVMBios" | "setVMFirmware" | "setVMBios"
    | "addVMNetworkAdapter" | "renameVMNetworkAdapter" | "setVMNetworkAdapter">;

type CreateNetworkClient = Pick<HyperVWindowsNetworkClient,
    "getVMSwitches" | "getAllVMNetworkAdapters" | "getVMNetworkAdapters">;

export type DeviceLabHyperVVmCreationOptions = {
    readonly request: HyperVCreateVirtualMachineRequest;
    readonly client: CreateVmClient;
    readonly networkClient: CreateNetworkClient;
    readonly effects: HyperVCreateEffect[];
    readonly deadlineAt: number;
    readonly onNewVmAttempt?: () => void;
};

export type DeviceLabHyperVVmCreationResult = {
    readonly vmId: string;
    readonly vmName: string;
    readonly state: string;
    readonly generation: 1 | 2;
    readonly diskPath: string;
    readonly switchName: string | null;
};

function sameWindowsPath(left: string | null, right: string): boolean {
    return left !== null && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** Runs the Hyper-V half of creation after the caller has verified the cloned disk. */
export async function executeDeviceLabHyperVVmCreation(
    options: DeviceLabHyperVVmCreationOptions,
): Promise<DeviceLabHyperVVmCreationResult> {
    const { request, client, networkClient, effects, deadlineAt } = options;
    // Every native call recomputes the broker deadline. The injected transport applies its own
    // per-call cap; this guard prevents a sequence of individually bounded calls overrunning it.
    const call = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
        assertHyperVOperationDeadline(deadlineAt);
        return operation();
    };
    const plan = planHyperVVirtualMachineCreation(request);
    const firstMutation = plan.findIndex((step) => step.kind === "create-vm");
    if (firstMutation < 0 || plan.slice(0, firstMutation).some((step) => step.kind !== "ensure-directory" && step.kind !== "copy-base-image")) {
        throw new Error("hyper-v-create-plan-invalid");
    }
    const existing = await call(() => client.getVM({ kind: "name", name: request.vmName }));
    if (existing.length !== 0) throw new Error("hyper-v-vm-already-exists");

    const network = request.network;
    let switchName: string | null = null;
    let switchId: string | null = null;
    let bootstrapSwitchName: string | null = null;
    let bootstrapSwitchId: string | null = null;
    if (network.kind !== "none") {
        const switches = await call(() => networkClient.getVMSwitches({ kind: "name", name: parseHyperVVirtualSwitchName(network.switchName) }));
        if (switches.length !== 1 || switches[0]?.name !== network.switchName) throw new Error("hyper-v-network-switch-not-found");
        switchName = switches[0].name;
        switchId = switches[0].id;
        if (network.kind === "managed-and-bootstrap") {
            const bootstrap = await call(() => networkClient.getVMSwitches({ kind: "name", name: parseHyperVVirtualSwitchName(network.bootstrapSwitchName) }));
            if (bootstrap.length !== 1 || bootstrap[0]?.name !== network.bootstrapSwitchName) {
                throw new Error("hyper-v-bootstrap-dhcp-switch-unavailable");
            }
            if (bootstrap[0].id === switches[0].id) throw new Error("hyper-v-bootstrap-network-switch-conflict");
            bootstrapSwitchName = bootstrap[0].name;
            bootstrapSwitchId = bootstrap[0].id;
            const bootstrapMac = parseHyperVMacAddress(`06${network.macAddress.slice(2)}`);
            const hostAdapters = await call(() => networkClient.getAllVMNetworkAdapters());
            if (hostAdapters.some((adapter) => adapter.macAddress === bootstrapMac)) {
                throw new Error("hyper-v-bootstrap-mac-address-conflict");
            }
        }
    }

    let vmId: string | null = null;
    let createdState = "Unknown";
    for (const step of plan.slice(firstMutation)) {
        if (step.kind === "create-vm") {
            const created = await call(() => {
                options.onNewVmAttempt?.();
                return client.newVM({
                    name: step.vmName,
                    generation: step.generation,
                    memoryStartupBytes: step.memoryStartupBytes,
                    vhdPath: step.vhdPath,
                    ...(step.switchName === null ? {} : { switchName: step.switchName }),
                });
            });
            if (created.name !== request.vmName || created.generation !== request.firmware.generation) {
                throw new Error("hyper-v-create-invalid-result");
            }
            // Record only a result with the expected name and generation. A malformed response
            // might name someone else's ID; that case is left to name/disk-fenced recovery.
            vmId = created.id;
            effects.push({ kind: "vm-created", vmId });
            createdState = created.state;
            continue;
        }
        if (vmId === null) throw new Error("hyper-v-create-plan-invalid");
        const selector = { kind: "id", id: vmId } as const;
        switch (step.kind) {
            case "rename-adapter":
                await call(() => client.renameVMNetworkAdapter({ selector, adapter: step.adapter, newName: step.to }));
                break;
            case "set-adapter-mac":
                await call(() => client.setVMNetworkAdapter({ selector, adapter: step.adapter, staticMacAddress: step.macAddress }));
                break;
            case "add-adapter":
                await call(() => client.addVMNetworkAdapter({ selector, name: step.adapterName, switchName: step.switchName }));
                break;
            case "set-processor-count":
                await call(() => client.setVMProcessor({ selector, count: step.count,
                    ...(step.exposeVirtualizationExtensions !== undefined ? { exposeVirtualizationExtensions: step.exposeVirtualizationExtensions } : {}),
                }));
                break;
            case "disable-dynamic-memory":
                await call(() => client.setVMMemory({ selector, dynamicMemoryEnabled: false }));
                break;
            case "set-vm-settings":
                await call(() => client.setVM({ selector, notes: step.notes, checkpointType: step.checkpointType, automaticCheckpointsEnabled: step.automaticCheckpointsEnabled }));
                break;
            case "set-bios-startup-order":
                await call(() => client.setVMBios({ selector, startupOrder: step.startupOrder }));
                break;
            case "configure-firmware":
                await call(() => client.setVMFirmware({ selector, secureBoot: step.secureBoot, firstBootDiskPath: step.firstBootDiskPath }));
                break;
            default:
                throw new Error("hyper-v-create-plan-invalid");
        }
    }
    if (vmId === null) throw new Error("hyper-v-create-plan-invalid");
    const selector = { kind: "id", id: vmId } as const;
    const observedVm = await call(() => client.getVM(selector));
    const hardDisks = await call(() => client.getVMHardDiskDrives(selector));
    if (observedVm.length !== 1 || observedVm[0]?.id !== vmId || observedVm[0].name !== request.vmName
        || observedVm[0].notes !== request.notes || observedVm[0].generation !== request.firmware.generation) {
        throw new Error("hyper-v-create-invalid-result");
    }
    if (hardDisks.length !== 1 || hardDisks[0]?.vmId !== vmId
        || !sameWindowsPath(hardDisks[0].path, request.diskPath)) {
        throw new Error("hyper-v-created-disk-attachment-mismatch");
    }
    if (request.firmware.generation === 2) {
        const firmware = await call(() => client.getVMFirmware(selector));
        if (firmware.vmId !== vmId || !sameWindowsPath(firmware.firstBootDevicePath, request.diskPath)) {
            throw new Error("hyper-v-created-disk-boot-order-mismatch");
        }
    } else {
        const expectedStartupOrder = request.firmware.startupOrder;
        const bios = await call(() => client.getVMBios(selector));
        if (bios.vmId !== vmId || bios.startupOrder.length !== expectedStartupOrder.length
            || bios.startupOrder.some((device, index) => device !== expectedStartupOrder[index])) {
            throw new Error("hyper-v-created-disk-boot-order-mismatch");
        }
    }
    if (network.kind !== "none") {
        const adapters = await call(() => networkClient.getVMNetworkAdapters({ selector }));
        const managed = adapters.filter((adapter) => adapter.name === network.adapterName
            && adapter.vmId === vmId && adapter.switchId === switchId && adapter.switchName === switchName);
        if (managed.length !== 1 || (network.macAddress !== null
            && managed[0]?.macAddress !== parseHyperVMacAddress(network.macAddress))) {
            throw new Error("hyper-v-managed-network-adapter-unavailable");
        }
        if (network.kind === "managed-and-bootstrap") {
            const bootstrapMac = parseHyperVMacAddress(`06${network.macAddress.slice(2)}`);
            const bootstrap = adapters.filter((adapter) => adapter.name === network.bootstrapAdapterName
                && adapter.vmId === vmId && adapter.switchId === bootstrapSwitchId
                && adapter.switchName === bootstrapSwitchName && adapter.macAddress === bootstrapMac);
            if (bootstrap.length !== 1 || adapters.length !== 2) throw new Error("hyper-v-bootstrap-network-adapter-unavailable");
            const hostAdapters = await call(() => networkClient.getAllVMNetworkAdapters());
            const assigned = hostAdapters.filter((adapter) => adapter.macAddress === bootstrapMac);
            if (assigned.length !== 1 || assigned[0]?.vmId !== vmId || assigned[0].name !== network.bootstrapAdapterName) {
                throw new Error("hyper-v-bootstrap-mac-address-conflict");
            }
        } else if (adapters.length !== 1) {
            throw new Error("hyper-v-managed-network-adapter-unavailable");
        }
    }
    assertHyperVOperationDeadline(deadlineAt);
    return {
        vmId,
        vmName: request.vmName,
        state: observedVm[0].state || createdState,
        generation: request.firmware.generation,
        diskPath: request.diskPath,
        switchName,
    };
}
