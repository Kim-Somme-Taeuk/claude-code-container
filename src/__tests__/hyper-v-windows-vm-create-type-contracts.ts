import type {
    HyperVBiosStartupDevice,
    HyperVSecureBootSetting,
    HyperVVirtualMachineGeneration,
} from "../hyper-v-windows/low-level/contracts.js";
import type {
    HyperVCreateEffect,
    HyperVCreateNetworkIntent,
} from "../hyper-v-windows/lifecycle/vm-create-contracts.js";

// These assertions fail by COMPILING. Each `@ts-expect-error` is a claim that the combination
// below it cannot be written; if a future change makes one writable, the directive becomes
// unused and this file stops compiling. The legacy command enforced the first two with a
// runtime `throw` reached only on a real host.

// A generation-1 VM has a BIOS and no firmware object, so Secure Boot has nowhere to live.
// This is the invariant `vm-create.ts` spent a runtime check on.
export const secureBootNeedsGeneration2: HyperVVirtualMachineGeneration = {
    generation: 1,
    // @ts-expect-error Secure Boot is a generation-2 firmware setting
    secureBoot: { enabled: true, template: "MicrosoftWindows" },
};

// A generation-2 VM has firmware and no BIOS, so a startup order has nowhere to live.
export const startupOrderNeedsGeneration1: HyperVVirtualMachineGeneration = {
    generation: 2,
    // @ts-expect-error a BIOS startup order is a generation-1 setting
    startupOrder: ["IDE"],
};

// Native rejects a template when Secure Boot is off, so the pair cannot be expressed.
export const disabledSecureBootCarriesNoTemplate: HyperVSecureBootSetting = {
    enabled: false,
    // @ts-expect-error a disabled Secure Boot has no template
    template: "MicrosoftWindows",
};

// Each generation must still be writable in its own shape, or the union above would be
// proving its point by forbidding everything.
export const generation1IsWritable: HyperVVirtualMachineGeneration = {
    generation: 1,
    startupOrder: ["IDE", "CD"],
};

export const generation2IsWritable: HyperVVirtualMachineGeneration = {
    generation: 2,
    secureBoot: { enabled: false },
};

// @ts-expect-error a startup device outside the four native accepts is not a startup device
export const unknownStartupDevice: HyperVBiosStartupDevice = "USB";

// A bootstrap guest needs an address on both adapters: the bootstrap one is how it is reached
// before the device network works, so it cannot be left unaddressed the way a managed-only
// adapter can. The two intents differ in exactly that, and the difference is a type.
export const bootstrapAddressIsNotOptional: HyperVCreateNetworkIntent = {
    kind: "managed-and-bootstrap",
    switchName: "ccc-internal",
    adapterName: "CCC Device Network",
    macAddress: "02:15:5d:01:1a:2c",
    bootstrapSwitchName: "Default Switch",
    bootstrapAdapterName: "CCC Bootstrap DHCP",
    // @ts-expect-error a bootstrap adapter with no address cannot be reached, so null is not a value here
    bootstrapMacAddress: null,
};

// A VM with no network carries no switch to name.
export const noNetworkCarriesNoSwitch: HyperVCreateNetworkIntent = {
    kind: "none",
    // @ts-expect-error a VM with no network has no switch
    switchName: "ccc-internal",
};

// An effect records what happened, so a directory effect cannot carry a VM id and a VM effect
// cannot carry a path. Mixing them is how a compensation aims at the wrong thing.
export const directoryEffectCarriesNoVmId: HyperVCreateEffect = {
    kind: "directory-created",
    path: "C:\\ccc\\devices\\device-1",
    // @ts-expect-error a directory was not a virtual machine
    vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};
