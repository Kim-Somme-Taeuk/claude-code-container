import type {
    HyperVVirtualMachineGeneration,
    HyperVVMNetworkAdapterTarget,
} from "../low-level/contracts.js";

/**
 * What one VM creation needs, with the parts that cannot vary together already resolved.
 *
 * Paths arrive as plain strings. Where they point and who may write them is consumer policy,
 * and the library is not the place that decides it -- but the library does decide the order
 * they are used in and what happens when a step fails partway.
 */
export type HyperVCreateVirtualMachineRequest = {
    readonly vmName: string;
    // Generation and the firmware settings that belong to it, as one value. A generation-1 VM
    // carries a BIOS startup order and a generation-2 VM carries Secure Boot; neither can be
    // written against the other, which is the invariant the legacy command enforced with a
    // runtime throw.
    readonly firmware: HyperVVirtualMachineGeneration;
    readonly memoryStartupBytes: number;
    readonly processorCount: number;
    readonly notes: string;
    readonly checkpointType: "Disabled" | "Production" | "ProductionOnly" | "Standard";
    // The directory the device owns, and the disk inside it. Both may already exist; the plan
    // records which ones creation actually made, because only those may be removed on failure.
    readonly deviceRoot: string;
    readonly diskPath: string;
    readonly baseImagePath: string;
    readonly baseImageSha256: string;
    readonly network: HyperVCreateNetworkIntent;
};

/**
 * Which adapters the VM gets. `none` is not the absence of a setting -- it is the decision to
 * create a VM with no network, which native expresses by being given no switch at all.
 *
 * `managed-and-bootstrap` exists because a Linux guest needs DHCP from the default switch
 * before it can be reached on the device network. Its two adapters are created by different
 * cmdlets -- the first comes free with `New-VM`, the second needs `Add-VMNetworkAdapter` --
 * so the pairing is recorded here rather than rediscovered at execution time.
 */
export type HyperVCreateNetworkIntent =
    | { readonly kind: "none" }
    | {
        readonly kind: "managed";
        readonly switchName: string;
        readonly adapterName: string;
        readonly macAddress: string | null;
    }
    | {
        readonly kind: "managed-and-bootstrap";
        readonly switchName: string;
        readonly adapterName: string;
        readonly macAddress: string;
        readonly bootstrapSwitchName: string;
        readonly bootstrapAdapterName: string;
    };
// The bootstrap address is DERIVED from the managed one, never supplied beside it. The two
// adapters of one device differ in the locally administered prefix and nowhere else, so a
// second field would let a caller hand in a pair that is accidentally equal -- an invariant
// the PowerShell this replaces got for free by computing it.

/**
 * One step of creation, in the order it must run.
 *
 * Steps that change nothing on the host carry no compensation and are not represented here at
 * all: host capacity and path inspection belong to the caller, which can refuse before any of
 * this starts. What this describes is only the part that leaves residue if it stops halfway.
 */
export type HyperVCreateStep =
    | { readonly kind: "ensure-directory"; readonly path: string }
    | {
        readonly kind: "copy-base-image";
        readonly source: string;
        readonly destination: string;
        readonly expectedSha256: string;
    }
    | {
        readonly kind: "create-vm";
        readonly vmName: string;
        readonly generation: 1 | 2;
        readonly memoryStartupBytes: number;
        readonly vhdPath: string;
        // The switch New-VM attaches the first adapter to, if any. For the bootstrap case this
        // is the bootstrap switch, because the adapter New-VM creates is the one that must
        // carry DHCP -- the device adapter is added afterwards.
        readonly switchName: string | null;
    }
    // Carries no source name. The adapter New-VM creates is spelled in the host's display
    // language, so naming it would be a literal that is wrong on a localized Hyper-V -- and
    // the PowerShell this replaces never named it either: it asserted the VM had exactly one
    // adapter and took that one. `sole` is that assertion.
    | { readonly kind: "rename-adapter"; readonly adapter: HyperVVMNetworkAdapterTarget; readonly to: string }
    | { readonly kind: "set-adapter-mac"; readonly adapter: HyperVVMNetworkAdapterTarget; readonly macAddress: string }
    | { readonly kind: "add-adapter"; readonly adapterName: string; readonly switchName: string }
    | { readonly kind: "set-processor-count"; readonly count: number }
    | { readonly kind: "disable-dynamic-memory" }
    | {
        readonly kind: "set-vm-settings";
        readonly notes: string;
        readonly checkpointType: "Disabled" | "Production" | "ProductionOnly" | "Standard";
    }
    | {
        readonly kind: "configure-firmware";
        readonly firmware: HyperVVirtualMachineGeneration;
        readonly firstBootDiskPath: string;
    };

/**
 * A change creation actually made, recorded as it is made.
 *
 * This is the whole reason compensation is trustworthy. The legacy script did the same thing
 * with local variables -- `$CreatedVm`, `$DeviceRootExisted` -- and its rollback consulted
 * those rather than re-deriving intent from the request. A directory that was already there
 * produces no effect and is therefore never removed, which is the single most important
 * property here: creation must not delete a device root it did not create.
 */
export type HyperVCreateEffect =
    | { readonly kind: "directory-created"; readonly path: string }
    | { readonly kind: "file-created"; readonly path: string }
    | { readonly kind: "vm-created"; readonly vmId: string };

/**
 * One undo, in the order it must run.
 *
 * Every compensation is best-effort and independent: the legacy rollback wrapped each in its
 * own `catch` so that a failure to remove the disk still let it remove the device root. That
 * is a property of the plan, not of the executor, so it is stated here -- a caller that stops
 * the sequence on the first error is not running this plan.
 */
export type HyperVCreateCompensation =
    | { readonly kind: "remove-vm"; readonly vmId: string }
    | { readonly kind: "delete-file"; readonly path: string }
    | { readonly kind: "delete-directory"; readonly path: string };
