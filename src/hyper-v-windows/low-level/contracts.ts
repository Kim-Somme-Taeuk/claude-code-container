import type {
    HyperVCreateNetIPAddressRequest,
    HyperVCreateNetNatRequest,
    HyperVCreateVMSwitchRequest,
    HyperVExactNameVMInventoryRequest,
    HyperVGetHostNetworkAdaptersRequest,
    HyperVGetManagementNetworkAdaptersRequest,
    HyperVGetNetNeighborsRequest,
    HyperVGetVMNetworkAdaptersRequest,
    HyperVNatSelector,
    HyperVNetIPAddressSelector,
    HyperVRemoveNetIPAddressRequest,
    HyperVRemoveNetNatRequest,
    HyperVRemoveVMNetworkAdapterRequest,
    HyperVRemoveVMSwitchRequest,
    HyperVSetVMSwitchNotesRequest,
    HyperVVirtualSwitchSelector,
} from "./network-contracts.js";

export const HYPER_V_WINDOWS_OPERATIONS = Object.freeze([
    "Get-VM",
    "Get-VMHardDiskDrive",
    "Get-VMDvdDrive",
    "Get-VMSnapshot",
    "Start-VM",
    "Stop-VM",
    "Remove-VM",
    "Checkpoint-VM",
    "Remove-VMSnapshot",
    "Restore-VMSnapshot",
    "Get-VMSwitch",
    "New-VMSwitch",
    "Set-VMSwitch",
    "Remove-VMSwitch",
    "New-VM",
    "Set-VM",
    "Set-VMMemory",
    "Set-VMProcessor",
    "Get-VMFirmware",
    "Set-VMFirmware",
    "Set-VMBios",
    "Get-VMNetworkAdapter",
    "Add-VMNetworkAdapter",
    "Rename-VMNetworkAdapter",
    "Set-VMNetworkAdapter",
    "Remove-VMNetworkAdapter",
    "Get-NetAdapter",
    "Get-NetNeighbor",
    "Get-NetIPAddress",
    "New-NetIPAddress",
    "Remove-NetIPAddress",
    "Get-NetNat",
    "New-NetNat",
    "Remove-NetNat",
] as const);

export type HyperVWindowsOperation = typeof HYPER_V_WINDOWS_OPERATIONS[number];

export type HyperVVirtualMachineSelector =
    | { readonly kind: "id"; readonly id: string }
    | { readonly kind: "name"; readonly name: string };

// Snapshots are addressed the same way virtual machines are: by native id or by native name.
// Consumer naming conventions stay outside this library.
export type HyperVSnapshotSelector =
    | { readonly kind: "id"; readonly id: string }
    | { readonly kind: "name"; readonly name: string };

export type HyperVVirtualMachine = {
    readonly id: string;
    readonly name: string;
    readonly state: string;
    readonly status: string;
    readonly notes: string;
    readonly uptimeMilliseconds: number;
    readonly generation: number;
    readonly checkpointType: string;
};

export type HyperVHardDiskDrive = {
    readonly vmId: string;
    readonly vmName: string;
    readonly path: string | null;
    readonly controllerType: string;
    readonly controllerNumber: number;
    readonly controllerLocation: number;
    readonly diskNumber: number | null;
};

export type HyperVDvdDrive = {
    readonly vmId: string;
    readonly vmName: string;
    readonly path: string | null;
    readonly controllerType: string;
    readonly controllerNumber: number;
    readonly controllerLocation: number;
};

export type HyperVVirtualMachineSnapshot = {
    readonly id: string;
    readonly name: string;
    readonly vmId: string;
    readonly vmName: string;
    readonly snapshotType: string;
    readonly parentSnapshotId: string | null;
    readonly parentSnapshotName: string | null;
    readonly creationTimeMilliseconds: number;
};

type HyperVWindowsExecutionRequestBase<Operation extends HyperVWindowsOperation> = {
    readonly schemaVersion: 1;
    readonly operation: Operation;
    readonly selector: HyperVVirtualMachineSelector;
    readonly names?: never;
};

type HyperVWindowsHostExecutionRequestBase<Operation extends HyperVWindowsOperation> = {
    readonly schemaVersion: 1;
    readonly operation: Operation;
};

type HyperVWindowsHostExecutionRequestWithoutSelectorBase<Operation extends HyperVWindowsOperation> =
    HyperVWindowsHostExecutionRequestBase<Operation> & { readonly selector?: never };

export type HyperVWindowsExecutionRequest =
    | HyperVWindowsExecutionRequestBase<"Get-VM">
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VM"> & HyperVExactNameVMInventoryRequest)
    | HyperVWindowsExecutionRequestBase<"Get-VMHardDiskDrive">
    | HyperVWindowsExecutionRequestBase<"Get-VMDvdDrive">
    | HyperVWindowsExecutionRequestBase<"Get-VMSnapshot">
    | HyperVWindowsExecutionRequestBase<"Start-VM">
    | (HyperVWindowsExecutionRequestBase<"Stop-VM"> & {
        readonly mode: "shutdown" | "turn-off";
        readonly force: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Remove-VM"> & {
        readonly force: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Checkpoint-VM"> & {
        readonly snapshotName: string;
    })
    | (HyperVWindowsExecutionRequestBase<"Remove-VMSnapshot"> & {
        readonly snapshot: HyperVSnapshotSelector;
        readonly includeDescendants: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Restore-VMSnapshot"> & {
        readonly snapshot: HyperVSnapshotSelector;
    })
    | (HyperVWindowsHostExecutionRequestBase<"Get-VMSwitch"> & {
        readonly selector: HyperVVirtualSwitchSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-VMSwitch"> & HyperVCreateVMSwitchRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Set-VMSwitch"> & HyperVSetVMSwitchNotesRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-VMSwitch"> & HyperVRemoveVMSwitchRequest)
    | HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VMNetworkAdapter">
    | (HyperVWindowsHostExecutionRequestBase<"Get-VMNetworkAdapter"> & HyperVGetVMNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-VMNetworkAdapter"> & HyperVGetManagementNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Remove-VMNetworkAdapter"> & HyperVRemoveVMNetworkAdapterRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-NetAdapter"> & HyperVGetHostNetworkAdaptersRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Get-NetNeighbor"> & HyperVGetNetNeighborsRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Get-NetIPAddress"> & {
        readonly selector: HyperVNetIPAddressSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-NetIPAddress"> & HyperVCreateNetIPAddressRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-NetIPAddress"> & HyperVRemoveNetIPAddressRequest)
    | (HyperVWindowsHostExecutionRequestBase<"Get-NetNat"> & {
        readonly selector: HyperVNatSelector;
    })
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-NetNat"> & HyperVCreateNetNatRequest)
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"Remove-NetNat"> & HyperVRemoveNetNatRequest)
    // Creation carries no selector: it is the call that brings the VM into existence, so there
    // is nothing yet to select. Every step after it selects by the id this call returns.
    | (HyperVWindowsHostExecutionRequestWithoutSelectorBase<"New-VM"> & {
        readonly name: string;
        readonly generation: 1 | 2;
        readonly memoryStartupBytes: number;
        readonly vhdPath?: string;
        readonly switchName?: string;
    })
    // Set-VM's fields stay optional on the wire because native applies only what it is given.
    // The client refuses a request naming none of them, so an all-absent shape never ships.
    | (HyperVWindowsExecutionRequestBase<"Set-VM"> & {
        readonly notes?: string;
        readonly automaticCheckpointsEnabled?: boolean;
        readonly checkpointType?: "Disabled" | "Production" | "ProductionOnly" | "Standard";
    })
    | (HyperVWindowsExecutionRequestBase<"Set-VMMemory"> & {
        readonly dynamicMemoryEnabled: boolean;
    })
    | (HyperVWindowsExecutionRequestBase<"Set-VMProcessor"> & {
        readonly count: number;
    })
    | HyperVWindowsExecutionRequestBase<"Get-VMFirmware">
    | (HyperVWindowsExecutionRequestBase<"Set-VMFirmware"> & {
        readonly secureBoot: HyperVSecureBootSetting;
        readonly firstBootDiskPath?: string;
    })
    | (HyperVWindowsExecutionRequestBase<"Set-VMBios"> & {
        readonly startupOrder: readonly HyperVBiosStartupDevice[];
    })
    | (HyperVWindowsExecutionRequestBase<"Add-VMNetworkAdapter"> & {
        readonly name: string;
        readonly switchName: string;
    })
    | (HyperVWindowsExecutionRequestBase<"Rename-VMNetworkAdapter"> & {
        readonly name: string;
        readonly newName: string;
    })
    | (HyperVWindowsExecutionRequestBase<"Set-VMNetworkAdapter"> & {
        readonly name: string;
        readonly staticMacAddress: string;
    });

export type HyperVWindowsExecutionResult = {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr?: string;
    readonly error?: string;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly outputLimitExceeded?: boolean;
};

export type HyperVWindowsExecutionContext = {
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
};

export type HyperVWindowsExecutor = {
    execute(
        request: HyperVWindowsExecutionRequest,
        context: HyperVWindowsExecutionContext,
    ): HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>;
};

export type HyperVWindowsCallOptions = {
    readonly signal?: AbortSignal;
};

export type HyperVStartVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
};

export type HyperVStopVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly mode: "shutdown" | "turn-off";
    readonly force?: boolean;
};

export type HyperVRemoveVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly force?: boolean;
};

export type HyperVCheckpointVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshotName: string;
};

export type HyperVRemoveSnapshotRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshot: HyperVSnapshotSelector;
    // Native Remove-VMSnapshot removes only the named checkpoint unless -IncludeAllChildSnapshots.
    readonly includeDescendants?: boolean;
};

export type HyperVRestoreSnapshotRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly snapshot: HyperVSnapshotSelector;
};

// Hyper-V's two firmware worlds. A generation-1 VM has a BIOS and no firmware object;
// a generation-2 VM has firmware and no BIOS. Native enforces this by failing the call, and
// the PowerShell this replaces enforced it by branching on a number it carried separately
// from the settings it applied -- so nothing stopped the wrong branch being written.
//
// Modelling it as a union means the pairing is the type. `Set-VMFirmware` takes only the
// generation-2 member and `Set-VMBios` only the generation-1 member, so aiming either at the
// wrong generation does not compile. Secure Boot rides on the generation-2 member for the
// same reason: it is a firmware setting, and a generation-1 VM has nowhere to put it. That
// retires the runtime `throw` the legacy command needed for the same invariant.
export type HyperVVirtualMachineGeneration =
    | {
        readonly generation: 1;
        // Native Set-VMBios -StartupOrder. Order is the whole meaning of the value.
        readonly startupOrder: readonly HyperVBiosStartupDevice[];
    }
    | {
        readonly generation: 2;
        readonly secureBoot: HyperVSecureBootSetting;
    };

export type HyperVBiosStartupDevice = "IDE" | "CD" | "LegacyNetworkAdapter" | "Floppy";

// Off carries no template, because native rejects a template when Secure Boot is disabled.
// Two shapes rather than one optional field, so "disabled with a template" cannot be written.
export type HyperVSecureBootSetting =
    | { readonly enabled: false }
    | { readonly enabled: true; readonly template: string };

export type HyperVNewVirtualMachineRequest = {
    readonly name: string;
    readonly generation: 1 | 2;
    readonly memoryStartupBytes: number;
    // The VM boots from this disk, and native attaches it as part of creation rather than as
    // a later Add-VMHardDiskDrive. Absent means create the VM with no disk attached.
    readonly vhdPath?: string;
    readonly switchName?: string;
};

export type HyperVSetVMMemoryRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly dynamicMemoryEnabled: boolean;
};

export type HyperVSetVMProcessorRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly count: number;
};

// Set-VM carries settings that are neither memory nor processor. Every field is optional
// because native applies only the parameters it is given, and a request naming none of them
// is a no-op the caller should not be able to mistake for a mutation -- so the client
// refuses an empty one rather than issuing it.
export type HyperVSetVirtualMachineRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly notes?: string;
    readonly automaticCheckpointsEnabled?: boolean;
    readonly checkpointType?: "Disabled" | "Production" | "ProductionOnly" | "Standard";
};

export type HyperVSetVMFirmwareRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly secureBoot: HyperVSecureBootSetting;
    // The boot entry native should place first, named by the disk path it points at. The
    // caller has that path; making it name a device object instead would mean handing back
    // something only a previous native read could produce.
    readonly firstBootDiskPath?: string;
};

export type HyperVSetVMBiosRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly startupOrder: readonly HyperVBiosStartupDevice[];
};

export type HyperVVirtualMachineFirmware = {
    readonly vmId: string;
    readonly secureBoot: string;
    readonly secureBootTemplate: string;
    // The path of the first entry in the boot order, or absent when the first entry is not a
    // disk -- a network or DVD entry has no path, and reporting "" for it would be a value
    // that compares equal to nothing the caller can check.
    readonly firstBootDevicePath: string | null;
};

export type HyperVAddVMNetworkAdapterRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly name: string;
    readonly switchName: string;
};

export type HyperVRenameVMNetworkAdapterRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly name: string;
    readonly newName: string;
};

export type HyperVSetVMNetworkAdapterRequest = {
    readonly selector: HyperVVirtualMachineSelector;
    readonly name: string;
    // Static only. Native also accepts -DynamicMacAddress, but that is a different operation
    // on the same cmdlet: it clears an address rather than setting one, and the two have no
    // shared caller here.
    readonly staticMacAddress: string;
};

export type HyperVWindowsClient = {
    getVM(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVVirtualMachine[]>;
    getVMHardDiskDrives(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVHardDiskDrive[]>;
    getVMDvdDrives(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVDvdDrive[]>;
    startVM(
        request: HyperVStartVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    stopVM(
        request: HyperVStopVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    removeVM(
        request: HyperVRemoveVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    getVMSnapshots(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<readonly HyperVVirtualMachineSnapshot[]>;
    // Returns the checkpoint the host actually created, so the caller never has to re-read by name.
    checkpointVM(
        request: HyperVCheckpointVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<HyperVVirtualMachineSnapshot>;
    removeVMSnapshot(
        request: HyperVRemoveSnapshotRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    restoreVMSnapshot(
        request: HyperVRestoreSnapshotRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    // Returns the VM native created, so a caller never has to re-read by name to learn the id
    // it must use for every following step -- and never has to guess whether a name collision
    // means its own VM or someone else's.
    newVM(
        request: HyperVNewVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<HyperVVirtualMachine>;
    setVM(
        request: HyperVSetVirtualMachineRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    setVMMemory(
        request: HyperVSetVMMemoryRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    setVMProcessor(
        request: HyperVSetVMProcessorRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    getVMFirmware(
        selector: HyperVVirtualMachineSelector,
        options?: HyperVWindowsCallOptions,
    ): Promise<HyperVVirtualMachineFirmware>;
    setVMFirmware(
        request: HyperVSetVMFirmwareRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    setVMBios(
        request: HyperVSetVMBiosRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    addVMNetworkAdapter(
        request: HyperVAddVMNetworkAdapterRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    renameVMNetworkAdapter(
        request: HyperVRenameVMNetworkAdapterRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
    setVMNetworkAdapter(
        request: HyperVSetVMNetworkAdapterRequest,
        options?: HyperVWindowsCallOptions,
    ): Promise<void>;
};
