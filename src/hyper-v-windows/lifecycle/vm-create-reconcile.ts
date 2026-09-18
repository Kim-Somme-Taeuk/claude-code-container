import type {
    HyperVCreateCompensation,
    HyperVCreateEffect,
    HyperVCreateStep,
    HyperVCreateVirtualMachineRequest,
} from "./vm-create-contracts.js";

/**
 * Orders the steps that bring one VM into existence.
 *
 * The order is the behaviour, not an implementation detail, and three parts of it are load
 * bearing:
 *
 * - the disk is copied before `New-VM`, because `New-VM` attaches it and cannot attach a file
 *   that is not there yet;
 * - for a bootstrap guest, `New-VM` is given the *bootstrap* switch, because the adapter it
 *   creates for free is the one that must carry DHCP; the device adapter is added after, so
 *   that the two always land in the same relative order and their names are predictable;
 * - firmware is configured last, because the first boot device it names is the disk, and the
 *   disk is only attached to a VM once that VM exists.
 *
 * Pure: the same request always produces the same steps, and nothing here touches a host.
 */
export function planHyperVVirtualMachineCreation(
    request: HyperVCreateVirtualMachineRequest,
): readonly HyperVCreateStep[] {
    const steps: HyperVCreateStep[] = [
        { kind: "ensure-directory", path: request.deviceRoot },
        { kind: "ensure-directory", path: diskDirectoryOf(request.diskPath) },
        {
            kind: "copy-base-image",
            source: request.baseImagePath,
            destination: request.diskPath,
            expectedSha256: request.baseImageSha256,
        },
        {
            kind: "create-vm",
            vmName: request.vmName,
            generation: request.firmware.generation,
            memoryStartupBytes: request.memoryStartupBytes,
            vhdPath: request.diskPath,
            switchName: newVMSwitchNameOf(request),
        },
    ];

    const network = request.network;
    if (network.kind === "managed-and-bootstrap") {
        // The adapter New-VM made is on the bootstrap switch but still carries native's
        // default name. Renaming it before adding the second one keeps the two apart by name
        // at every moment in between -- if the device adapter were added first, both would
        // briefly answer to names the caller cannot tell apart.
        steps.push({ kind: "rename-adapter", from: DEFAULT_ADAPTER_NAME, to: network.bootstrapAdapterName });
        steps.push({
            kind: "set-adapter-mac",
            adapterName: network.bootstrapAdapterName,
            macAddress: network.bootstrapMacAddress,
        });
        steps.push({ kind: "add-adapter", adapterName: network.adapterName, switchName: network.switchName });
        steps.push({ kind: "set-adapter-mac", adapterName: network.adapterName, macAddress: network.macAddress });
    } else if (network.kind === "managed") {
        steps.push({ kind: "rename-adapter", from: DEFAULT_ADAPTER_NAME, to: network.adapterName });
        if (network.macAddress !== null) {
            steps.push({
                kind: "set-adapter-mac",
                adapterName: network.adapterName,
                macAddress: network.macAddress,
            });
        }
    }

    steps.push({ kind: "set-processor-count", count: request.processorCount });
    steps.push({ kind: "disable-dynamic-memory" });
    steps.push({ kind: "set-vm-settings", notes: request.notes, checkpointType: request.checkpointType });
    steps.push({
        kind: "configure-firmware",
        firmware: request.firmware,
        firstBootDiskPath: request.diskPath,
    });
    return Object.freeze(steps);
}

/**
 * Says how to undo what creation actually did, given what it recorded doing.
 *
 * Derived from effects rather than from the request, and that distinction is the point. A
 * device root that was already on disk produces no `directory-created` effect, so nothing here
 * can remove it -- creation must never delete a directory it found rather than made. The
 * legacy script kept the same fact in `$DeviceRootExisted` and consulted it in its rollback;
 * this is that variable, made explicit and made plural.
 *
 * Undone in reverse, because the later a change was made the more it depends on the earlier
 * ones: the VM must go before the disk it has attached, and the disk before the directory that
 * holds it. Applied to what the legacy script recorded, reverse order reproduces its rollback
 * sequence exactly -- remove the VM, delete the disk, then the directories.
 *
 * Every entry is best-effort and independent. A caller that stops at the first failure leaves
 * the residue the remaining entries exist to clear, and is not running this plan.
 */
export function planHyperVVirtualMachineCreationCompensation(
    effects: readonly HyperVCreateEffect[],
): readonly HyperVCreateCompensation[] {
    const compensations: HyperVCreateCompensation[] = [];
    for (let index = effects.length - 1; index >= 0; index -= 1) {
        const effect = effects[index];
        if (effect === undefined) continue;
        if (effect.kind === "vm-created") {
            compensations.push({ kind: "remove-vm", vmId: effect.vmId });
        } else if (effect.kind === "file-created") {
            compensations.push({ kind: "delete-file", path: effect.path });
        } else {
            compensations.push({ kind: "delete-directory", path: effect.path });
        }
    }
    return Object.freeze(compensations);
}

// Native's name for the adapter New-VM creates when it is given a switch. Renaming off it is
// what makes an adapter identifiable, so the spelling is part of the plan rather than a
// detail of whoever executes it.
const DEFAULT_ADAPTER_NAME = "Network Adapter";

// The switch New-VM itself attaches to. For a bootstrap guest that is deliberately the
// bootstrap switch and not the device switch: New-VM creates exactly one adapter, and the one
// it creates has to be the one the guest can reach DHCP on.
function newVMSwitchNameOf(request: HyperVCreateVirtualMachineRequest): string | null {
    const network = request.network;
    if (network.kind === "none") return null;
    if (network.kind === "managed-and-bootstrap") return network.bootstrapSwitchName;
    return network.switchName;
}

function diskDirectoryOf(diskPath: string): string {
    const separator = Math.max(diskPath.lastIndexOf("\\"), diskPath.lastIndexOf("/"));
    return separator <= 0 ? diskPath : diskPath.slice(0, separator);
}
