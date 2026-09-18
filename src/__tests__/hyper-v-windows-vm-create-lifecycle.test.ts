import { describe, expect, it } from "vitest";

import {
    effectKindOfStep,
    planHyperVVirtualMachineCreation,
    planHyperVVirtualMachineCreationCompensation,
} from "../hyper-v-windows/lifecycle/vm-create-reconcile.js";
import type {
    HyperVCreateEffect,
    HyperVCreateStep,
    HyperVCreateNetworkIntent,
    HyperVCreateVirtualMachineRequest,
} from "../hyper-v-windows/lifecycle/vm-create-contracts.js";

const DEVICE_ROOT = "C:\\ccc\\devices\\device-1";
const DISK_PATH = "C:\\ccc\\devices\\device-1\\disks\\root.vhdx";
const DISK_DIRECTORY = "C:\\ccc\\devices\\device-1\\disks";
const VM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function request(
    overrides: Partial<HyperVCreateVirtualMachineRequest> = {},
): HyperVCreateVirtualMachineRequest {
    return {
        vmName: "ccc-device-lab-abc",
        firmware: { generation: 2, secureBoot: { enabled: true, template: "MicrosoftWindows" } },
        memoryStartupBytes: 4096 * 1024 * 1024,
        processorCount: 2,
        notes: "ccc-device-lab:owner-1:device-1:incarnation-1",
        checkpointType: "ProductionOnly",
        deviceRoot: DEVICE_ROOT,
        diskPath: DISK_PATH,
        baseImagePath: "C:\\ccc\\images\\base.vhdx",
        baseImageSha256: "a".repeat(64),
        network: { kind: "none" },
        ...overrides,
    };
}

function kindsOf(network: HyperVCreateNetworkIntent): readonly string[] {
    return planHyperVVirtualMachineCreation(request({ network })).map((step) => step.kind);
}

describe("virtual machine creation planning", () => {
    // The disk is attached by New-VM, so it has to exist first. Any plan that creates the VM
    // before copying the image asks native to attach a file that is not there.
    it("copies the disk before creating the VM that attaches it", () => {
        const kinds = kindsOf({ kind: "none" });
        expect(kinds.indexOf("copy-base-image")).toBeLessThan(kinds.indexOf("create-vm"));
    });

    it("creates the directories before the disk that lands in them", () => {
        const steps = planHyperVVirtualMachineCreation(request());
        expect(steps.slice(0, 3)).toEqual([
            { kind: "ensure-directory", path: DEVICE_ROOT },
            { kind: "ensure-directory", path: DISK_DIRECTORY },
            {
                kind: "copy-base-image",
                source: "C:\\ccc\\images\\base.vhdx",
                destination: DISK_PATH,
                expectedSha256: "a".repeat(64),
            },
        ]);
    });

    // Firmware names the disk as first boot device, and a disk is only attached once the VM
    // exists. It is also the last thing that can fail before the VM is usable.
    it("configures firmware last", () => {
        const kinds = kindsOf({ kind: "none" });
        expect(kinds[kinds.length - 1]).toBe("configure-firmware");
    });

    it("creates a VM with no switch when no network is wanted", () => {
        const steps = planHyperVVirtualMachineCreation(request({ network: { kind: "none" } }));
        const create = steps.find((step) => step.kind === "create-vm");
        expect(create).toMatchObject({ kind: "create-vm", switchName: null });
        expect(steps.some((step) => step.kind === "add-adapter")).toBe(false);
        expect(steps.some((step) => step.kind === "rename-adapter")).toBe(false);
    });
});

describe("virtual machine creation planning, bootstrap networking", () => {
    const bootstrap: HyperVCreateNetworkIntent = {
        kind: "managed-and-bootstrap",
        switchName: "ccc-internal",
        adapterName: "CCC Device Network",
        macAddress: "02:15:5d:01:1a:2c",
        bootstrapSwitchName: "Default Switch",
        bootstrapAdapterName: "CCC Bootstrap DHCP",
    };

    // New-VM creates exactly one adapter, and for a guest that needs DHCP before it can be
    // reached, the one it creates has to be the bootstrap one. Attaching the device switch
    // here instead would leave the guest with no route to DHCP at all.
    it("gives New-VM the bootstrap switch, not the device switch", () => {
        const create = planHyperVVirtualMachineCreation(request({ network: bootstrap }))
            .find((step) => step.kind === "create-vm");
        expect(create).toMatchObject({ kind: "create-vm", switchName: "Default Switch" });
    });

    // Renaming before adding keeps the two adapters distinguishable by name at every moment.
    // Add first and both would briefly answer to names the caller cannot tell apart.
    it("renames the adapter New-VM made before adding the second one", () => {
        const kinds = kindsOf(bootstrap);
        expect(kinds.indexOf("rename-adapter")).toBeLessThan(kinds.indexOf("add-adapter"));
    });

    it("addresses both adapters, each on its own switch", () => {
        const steps = planHyperVVirtualMachineCreation(request({ network: bootstrap }));
        expect(steps.filter((step) => step.kind === "set-adapter-mac")).toEqual([
            {
                kind: "set-adapter-mac",
                adapter: { kind: "name", name: "CCC Bootstrap DHCP" },
                // Derived from the managed address, never supplied beside it -- so the two
                // adapters of one device cannot be handed in accidentally equal.
                macAddress: "06:15:5d:01:1a:2c",
            },
            {
                kind: "set-adapter-mac",
                adapter: { kind: "name", name: "CCC Device Network" },
                macAddress: "02:15:5d:01:1a:2c",
            },
        ]);
        expect(steps.filter((step) => step.kind === "add-adapter")).toEqual([
            { kind: "add-adapter", adapterName: "CCC Device Network", switchName: "ccc-internal" },
        ]);
    });

    // Nothing pinned this, and a mutation returning null here survived the whole suite. A
    // managed VM created with no switch gets no adapter at all, so the rename that follows
    // fails on the host and the device ends up with no network.
    it("gives New-VM the device switch when there is no bootstrap adapter", () => {
        const create = planHyperVVirtualMachineCreation(request({
            network: {
                kind: "managed",
                switchName: "ccc-internal",
                adapterName: "CCC Device Network",
                macAddress: "02:15:5d:01:1a:2c",
            },
        })).find((step) => step.kind === "create-vm");
        expect(create).toMatchObject({ kind: "create-vm", switchName: "ccc-internal" });
    });

    it("leaves a managed adapter unaddressed when no address was chosen", () => {
        const steps = planHyperVVirtualMachineCreation(request({
            network: {
                kind: "managed",
                switchName: "ccc-internal",
                adapterName: "CCC Device Network",
                macAddress: null,
            },
        }));
        expect(steps.some((step) => step.kind === "set-adapter-mac")).toBe(false);
        expect(steps.some((step) => step.kind === "rename-adapter")).toBe(true);
    });
});

describe("virtual machine creation compensation", () => {
    // The legacy PowerShell removed the VM, then the disk, then the device root. Reverse
    // order over what was recorded reproduces that, and for the reason that matters: the VM
    // holds the disk open and the directory holds the disk.
    it("undoes a full creation in the order the legacy rollback used", () => {
        const effects: readonly HyperVCreateEffect[] = [
            { kind: "directory-created", path: DEVICE_ROOT },
            { kind: "directory-created", path: DISK_DIRECTORY },
            { kind: "file-created", path: DISK_PATH },
            { kind: "vm-created", vmId: VM_ID },
        ];
        expect(planHyperVVirtualMachineCreationCompensation(effects)).toEqual([
            { kind: "remove-vm", vmId: VM_ID },
            { kind: "delete-file", path: DISK_PATH },
            { kind: "delete-directory", path: DISK_DIRECTORY },
            { kind: "delete-directory", path: DEVICE_ROOT },
        ]);
    });

    // This is the property the whole design exists for. The legacy script kept it in
    // $DeviceRootExisted: a device root that was already on disk is not creation's to delete,
    // and it is not deleted because it never produced an effect.
    it("never removes a directory creation found rather than made", () => {
        const effects: readonly HyperVCreateEffect[] = [
            { kind: "file-created", path: DISK_PATH },
            { kind: "vm-created", vmId: VM_ID },
        ];
        const compensations = planHyperVVirtualMachineCreationCompensation(effects);
        expect(compensations).toEqual([
            { kind: "remove-vm", vmId: VM_ID },
            { kind: "delete-file", path: DISK_PATH },
        ]);
        expect(compensations.some((entry) => entry.kind === "delete-directory")).toBe(false);
    });

    // Failure partway is the ordinary case, not the exceptional one: whatever had been done
    // by then is exactly what must come back out.
    it.each([
        [
            "nothing had been done yet",
            [] as readonly HyperVCreateEffect[],
            [],
        ],
        [
            "only the device root had been made",
            [{ kind: "directory-created", path: DEVICE_ROOT }] as readonly HyperVCreateEffect[],
            [{ kind: "delete-directory", path: DEVICE_ROOT }],
        ],
        [
            "the disk was copied but the VM was never created",
            [
                { kind: "directory-created", path: DEVICE_ROOT },
                { kind: "file-created", path: DISK_PATH },
            ] as readonly HyperVCreateEffect[],
            [
                { kind: "delete-file", path: DISK_PATH },
                { kind: "delete-directory", path: DEVICE_ROOT },
            ],
        ],
    ])("undoes exactly what was done when %s", (_label, effects, expected) => {
        expect(planHyperVVirtualMachineCreationCompensation(effects)).toEqual(expected);
    });

    // A VM that failed to configure still exists and still holds its disk, so removing it is
    // what frees the disk for deletion. Dropping this leaves an orphan VM the broker then has
    // to recover, which is the residue case the boundary ADR was written about.
    it("removes a VM that was created even when later configuration failed", () => {
        const effects: readonly HyperVCreateEffect[] = [
            { kind: "file-created", path: DISK_PATH },
            { kind: "vm-created", vmId: VM_ID },
        ];
        expect(planHyperVVirtualMachineCreationCompensation(effects)[0])
            .toEqual({ kind: "remove-vm", vmId: VM_ID });
    });
});

describe("virtual machine creation planning is pure", () => {
    it("returns the same steps for the same request", () => {
        expect(planHyperVVirtualMachineCreation(request()))
            .toEqual(planHyperVVirtualMachineCreation(request()));
    });

    // Only the arrays are frozen, so a caller cannot add or drop a step. Object.freeze is
    // shallow and the step objects themselves stay mutable; claiming otherwise would be a
    // test that reads stronger than what it checks.
    it("returns plans whose sequence a caller cannot add to or drop from", () => {
        const steps = planHyperVVirtualMachineCreation(request());
        expect(Object.isFrozen(steps)).toBe(true);
        expect(() => (steps as HyperVCreateStep[]).push({ kind: "disable-dynamic-memory" })).toThrow();
        expect(Object.isFrozen(planHyperVVirtualMachineCreationCompensation([]))).toBe(true);
    });
});

describe("every step says whether it leaves residue", () => {
    // The pairing the plan promised. `effectKindOfStep` is exhaustive, so a new step kind does
    // not compile until someone decides whether it leaves something behind -- which is what
    // makes "a step cannot be added without saying how to undo it" true rather than intended.
    it("answers for every step the planner can emit", () => {
        const networks: readonly HyperVCreateNetworkIntent[] = [
            { kind: "none" },
            { kind: "managed", switchName: "ccc-internal", adapterName: "CCC Device Network", macAddress: null },
            {
                kind: "managed-and-bootstrap",
                switchName: "ccc-internal",
                adapterName: "CCC Device Network",
                macAddress: "02:15:5d:01:1a:2c",
                bootstrapSwitchName: "Default Switch",
                bootstrapAdapterName: "CCC Bootstrap DHCP",
            },
        ];
        for (const network of networks) {
            for (const step of planHyperVVirtualMachineCreation(request({ network }))) {
                expect(() => effectKindOfStep(step)).not.toThrow();
            }
        }
    });

    // Only three steps can leave residue. Everything else changes the VM, and removing the VM
    // undoes all of it at once.
    it("names residue for exactly the three steps that create something", () => {
        const steps = planHyperVVirtualMachineCreation(request());
        const withEffects = steps
            .map((step) => [step.kind, effectKindOfStep(step)] as const)
            .filter(([, effect]) => effect !== null);
        expect(withEffects).toEqual([
            ["ensure-directory", "directory-created"],
            ["ensure-directory", "directory-created"],
            ["copy-base-image", "file-created"],
            ["create-vm", "vm-created"],
        ]);
    });

    // Each effect kind maps to its own compensation. There is no catch-all: an `else` would
    // make the next path-carrying effect anyone adds become a recursive directory delete,
    // which is the single thing this design exists to forbid.
    it.each([
        [{ kind: "vm-created", vmId: VM_ID }, { kind: "remove-vm", vmId: VM_ID }],
        [{ kind: "file-created", path: DISK_PATH }, { kind: "delete-file", path: DISK_PATH }],
        [{ kind: "directory-created", path: DEVICE_ROOT }, { kind: "delete-directory", path: DEVICE_ROOT }],
    ] as readonly (readonly [HyperVCreateEffect, unknown])[])(
        "compensates a %o with its own undo",
        (effect, expected) => {
            expect(planHyperVVirtualMachineCreationCompensation([effect])).toEqual([expected]);
        },
    );
});

describe("the disk directory a plan asks for", () => {
    // A bare filename has no directory to create, and asking to create one at the disk's own
    // path would collide with the file about to be written there.
    it.each([
        ["a nested path", "C:\\ccc\\devices\\d\\disks\\root.vhdx", "C:\\ccc\\devices\\d\\disks"],
        ["a drive-root path", "C:\\root.vhdx", "C:\\"],
        ["a bare filename", "root.vhdx", null],
    ])("resolves %s", (_label, diskPath, expected) => {
        const directories = planHyperVVirtualMachineCreation(request({ diskPath, deviceRoot: "D:\\elsewhere" }))
            .filter((step) => step.kind === "ensure-directory")
            .map((step) => (step as { path: string }).path);
        expect(directories).toEqual(expected === null ? ["D:\\elsewhere"] : ["D:\\elsewhere", expected]);
    });

    // The device root is already the first step, and asking for it twice would have the
    // executor record two directory-created effects for one directory.
    it("does not ask twice when the disk sits directly in the device root", () => {
        const directories = planHyperVVirtualMachineCreation(request({
            deviceRoot: "C:\\ccc\\devices\\d",
            diskPath: "C:\\ccc\\devices\\d\\root.vhdx",
        })).filter((step) => step.kind === "ensure-directory");
        expect(directories).toEqual([{ kind: "ensure-directory", path: "C:\\ccc\\devices\\d" }]);
    });
});

describe("the VM settings order", () => {
    // Processor, then memory, then Set-VM -- the order at vm-create.ts:223-225. Nothing about
    // these three requires that order: they touch independent settings and any order works.
    // It is pinned anyway, because the value of this slice is that the port can be checked
    // against the original line by line, and a silently drifted order makes that check useless.
    //
    // One thing here IS load-bearing and is NOT settled by this slice: `set-vm-settings`
    // carries the ownership marker, so until it runs the VM exists and orphan recovery cannot
    // recognise it as ccc's. The legacy has the same exposure, so matching it is right for 3A;
    // whether creation should write the marker earlier is a question for the slice that owns
    // the transaction. Recorded in doc/hyper-v-windows/NOTE__open-findings.md.
    it("matches the legacy order for processor, memory and settings", () => {
        const kinds = planHyperVVirtualMachineCreation(request()).map((step) => step.kind);
        expect(kinds.filter((kind) =>
            kind === "set-processor-count" || kind === "disable-dynamic-memory" || kind === "set-vm-settings"))
            .toEqual(["set-processor-count", "disable-dynamic-memory", "set-vm-settings"]);
    });

    // The bootstrap adapter is addressed before the device adapter is added, matching
    // vm-create.ts:205-207. Comparing the two set-adapter-mac entries only against each other
    // leaves the add free to drift between them.
    it("addresses the bootstrap adapter before adding the device adapter", () => {
        const kinds = kindsOf({
            kind: "managed-and-bootstrap",
            switchName: "ccc-internal",
            adapterName: "CCC Device Network",
            macAddress: "02:15:5d:01:1a:2c",
            bootstrapSwitchName: "Default Switch",
            bootstrapAdapterName: "CCC Bootstrap DHCP",
        });
        expect(kinds).toEqual([
            "ensure-directory",
            "ensure-directory",
            "copy-base-image",
            "create-vm",
            "rename-adapter",
            "set-adapter-mac",
            "add-adapter",
            "set-adapter-mac",
            "set-processor-count",
            "disable-dynamic-memory",
            "set-vm-settings",
            "configure-firmware",
        ]);
    });
});
