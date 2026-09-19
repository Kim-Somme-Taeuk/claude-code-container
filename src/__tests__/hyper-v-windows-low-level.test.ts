import { basename, join } from "path";
import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsClient,
    createHyperVWindowsPowerShellExecutor,
    HYPER_V_WINDOWS_POWERSHELL_ASSET,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES,
    hyperVWindowsPowerShellMemoryInput,
    HyperVWindowsError,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsOperation,
} from "../hyper-v-windows/low-level/index.js";
import { HYPER_V_POWERSHELL_MANIFEST } from "../host-control/hyper-v/powershell-manifest.js";

const vmId = "12345678-1234-1234-1234-123456789ABC";
const canonicalVmId = vmId.toLowerCase();
const selector = { kind: "id", id: vmId } as const;

const virtualMachine = {
    id: vmId,
    name: "library-test",
    state: "FutureState",
    status: "FutureStatus",
    notes: "opaque-notes",
    uptimeMilliseconds: 42,
    generation: 2,
    checkpointType: "FutureCheckpoint",
};

const virtualMachineFirmware = {
    vmId,
    secureBoot: "On",
    secureBootTemplate: "MicrosoftWindows",
    firstBootDevicePath: "C:\\devices\\device-1\\root.vhdx",
};

function response(
    operation: HyperVWindowsOperation,
    items: readonly unknown[] = [],
): HyperVWindowsExecutionResult {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    };
}

function executorUsing(
    execute: (request: HyperVWindowsExecutionRequest) => HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>,
): HyperVWindowsExecutor {
    return { execute };
}

describe("Hyper-V Windows low-level client", () => {
    it("maps each method to one exact native operation and normalized parameters", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const contexts: HyperVWindowsExecutionContext[] = [];
        const executor: HyperVWindowsExecutor = {
            execute(request, context) {
                requests.push(request);
                contexts.push(context);
                return response(request.operation, request.operation === "Get-VM" ? [virtualMachine] : []);
            },
        };
        const client = createHyperVWindowsClient(executor);

        await client.getVM(selector);
        await client.getVMHardDiskDrives(selector);
        await client.getVMDvdDrives(selector);
        await client.startVM({ selector });
        await client.stopVM({ selector, mode: "shutdown" });
        await client.removeVM({ selector, force: true });

        expect(requests).toEqual([
            { schemaVersion: 1, operation: "Get-VM", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Get-VMHardDiskDrive", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Get-VMDvdDrive", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Start-VM", selector: { kind: "id", id: canonicalVmId } },
            { schemaVersion: 1, operation: "Stop-VM", selector: { kind: "id", id: canonicalVmId }, mode: "shutdown", force: false },
            { schemaVersion: 1, operation: "Remove-VM", selector: { kind: "id", id: canonicalVmId }, force: true },
        ]);
        expect(contexts).toEqual(Array.from({ length: 6 }, () => ({
            timeoutMilliseconds: 120_000,
            maximumOutputBytes: 65_536,
        })));
    });

    it("preserves zero, one, and many attachment records in native order", async () => {
        const outputs = new Map<HyperVWindowsOperation, readonly unknown[]>([
            ["Get-VM", []],
            ["Get-VMHardDiskDrive", [
                {
                    vmId,
                    vmName: "library-test",
                    path: "C:\\VMs\\one.vhdx",
                    controllerType: "SCSI",
                    controllerNumber: 0,
                    controllerLocation: 0,
                    diskNumber: null,
                },
                {
                    vmId,
                    vmName: "library-test",
                    path: null,
                    controllerType: "FutureController",
                    controllerNumber: 0,
                    controllerLocation: 1,
                    diskNumber: 7,
                },
            ]],
            ["Get-VMDvdDrive", [
                {
                    vmId,
                    vmName: "library-test",
                    path: null,
                    controllerType: "SCSI",
                    controllerNumber: 0,
                    controllerLocation: 2,
                },
            ]],
        ]);
        const client = createHyperVWindowsClient(executorUsing((request) => response(
            request.operation,
            outputs.get(request.operation) ?? [],
        )));

        await expect(client.getVM(selector)).resolves.toEqual([]);
        await expect(client.getVMHardDiskDrives(selector)).resolves.toEqual([
            expect.objectContaining({ path: "C:\\VMs\\one.vhdx", controllerLocation: 0 }),
            expect.objectContaining({ path: null, controllerType: "FutureController", diskNumber: 7 }),
        ]);
        await expect(client.getVMDvdDrives(selector)).resolves.toEqual([
            expect.objectContaining({ path: null, controllerLocation: 2 }),
        ]);
    });

    it("preserves unknown native VM strings and canonicalizes GUIDs", async () => {
        const client = createHyperVWindowsClient(executorUsing((request) => response(request.operation, [virtualMachine])));

        await expect(client.getVM(selector)).resolves.toEqual([{
            ...virtualMachine,
            id: canonicalVmId,
        }]);
    });

    it("rejects invalid requests before invoking the executor", async () => {
        const execute = vi.fn(() => response("Get-VM"));
        const client = createHyperVWindowsClient(executorUsing(execute));

        await expect(client.getVM({ kind: "id", id: "not-a-guid" })).rejects.toMatchObject({
            category: "validation",
            operation: "Get-VM",
            code: "selector-id-invalid",
        });
        await expect(client.startVM({ selector: { kind: "name", name: "unsafe*" } })).rejects.toMatchObject({
            category: "validation",
            operation: "Start-VM",
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ["malformed", { status: 0, stdout: "not-json" }, "protocol", "response-malformed"],
        ["oversized", { status: null, stdout: "x".repeat(65 * 1024), error: "spawn ENOBUFS", outputLimitExceeded: true }, "protocol", "response-too-large"],
        ["ambiguous", response("Start-VM", [virtualMachine]), "protocol", "result-ambiguous"],
        ["timeout", { status: null, stdout: "", timedOut: true }, "transport", "timeout"],
        ["cancellation", { status: null, stdout: "", cancelled: true }, "transport", "cancelled"],
        ["executor error", { status: null, stdout: "", error: "private process detail" }, "transport", "executor-failed"],
    ] as const)("normalizes %s without leaking executor details", async (_label, execution, category, code) => {
        const client = createHyperVWindowsClient(executorUsing(() => execution));
        const caught = await client.startVM({ selector }).catch((failure: unknown) => failure);

        expect(caught).toBeInstanceOf(HyperVWindowsError);
        expect(caught).toMatchObject({ category, operation: "Start-VM", code });
        expect(String(caught)).not.toContain("private process detail");
    });

    it("normalizes a bounded native failure envelope", async () => {
        const client = createHyperVWindowsClient(executorUsing(() => ({
            status: 1,
            stdout: JSON.stringify({
                schemaVersion: 1,
                operation: "Remove-VM",
                ok: false,
                errorCode: "virtual-machine-not-found",
            }),
            stderr: "unbounded native detail",
        })));

        const caught = await client.removeVM({ selector }).catch((failure: unknown) => failure);
        expect(caught).toMatchObject({
            category: "native",
            operation: "Remove-VM",
            code: "virtual-machine-not-found",
            nativeStatus: 1,
        });
        expect(String(caught)).not.toContain("unbounded native detail");
    });

    it("normalizes rejected executors and already-aborted calls as transport failures", async () => {
        const rejected = createHyperVWindowsClient(executorUsing(() => Promise.reject(new Error("secret"))));
        await expect(rejected.getVM(selector)).rejects.toMatchObject({
            category: "transport",
            operation: "Get-VM",
            code: "executor-failed",
        });

        const execute = vi.fn(() => response("Get-VM"));
        const aborted = createHyperVWindowsClient(executorUsing(execute));
        const controller = new AbortController();
        controller.abort();
        await expect(aborted.getVM(selector, { signal: controller.signal })).rejects.toMatchObject({
            category: "transport",
            code: "cancelled",
        });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe("Hyper-V Windows PowerShell transport", () => {
    it("defines one bounded in-memory execution envelope for transport consumers", () => {
        const processInput = hyperVWindowsPowerShellMemoryInput({
            scriptSource: "$global:CccHyperVJsonInput | Out-Null",
            input: "{\"ok\":true}\n",
        });

        expect(JSON.parse(Buffer.from(processInput, "base64").toString("utf8"))).toEqual({
            script: "$global:CccHyperVJsonInput | Out-Null",
            input: "{\"ok\":true}\n",
        });
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).toContain("ScriptBlock");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).toContain("[Convert]::FromBase64String([Console]::In.ReadToEnd())");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("[Console]::InputEncoding =");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("[Console]::OutputEncoding =");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("StreamReader");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP).not.toContain("StreamWriter");
        expect(() => hyperVWindowsPowerShellMemoryInput({
            scriptSource: "x".repeat(HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES),
            input: "{}\n",
        })).toThrow("hyper-v-windows-powershell-memory-input-too-large");
    });

    it("uses the integrity-pinned generic asset and a bounded JSON request", async () => {
        const run = vi.fn((request: { scriptPath: string; scriptSource: string; input: string }) => response("Get-VM"));
        const executor = createHyperVWindowsPowerShellExecutor({ executable: "powershell.exe", run });
        const request: HyperVWindowsExecutionRequest = {
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "id", id: canonicalVmId },
        };

        await executor.execute(request, { timeoutMilliseconds: 120_000, maximumOutputBytes: 65_536 });

        expect(run).toHaveBeenCalledOnce();
        const fileRequest = run.mock.calls[0][0];
        expect(basename(fileRequest.scriptPath)).toBe("Invoke-HyperVWindowsOperation.ps1");
        expect(JSON.parse(fileRequest.input)).toEqual(request);
        expect(fileRequest.input.endsWith("\n")).toBe(true);
        const source = fileRequest.scriptSource;
        expect(source).toBe(readFileSync(fileRequest.scriptPath, "utf8"));
        expect(source).toContain('[Environment]::SystemDirectory');
        expect(source).toContain('Import-Module -Name $ModulePath -Force -PassThru');
        expect(source).toContain("Resolve-HyperVWindowsTrustedModulePath");
        expect(source).toContain("$ModulePath = Resolve-HyperVWindowsTrustedModulePath");
        expect(source).toContain("Get-ChildItem -LiteralPath $ModuleRoot -Directory");
        expect(source).toContain("[Version]$VersionDirectory.Name");
        expect(source).toContain("[string]$_.ModuleBase");
        expect(source).toContain("[IO.FileAttributes]::ReparsePoint");
        expect(source).toContain('Hyper-V\\Get-VM -ErrorAction Stop');
        expect(source).toContain('Hyper-V\\Remove-VM -VM $VirtualMachine');
        expect(source).toContain('$RawRequest = [string]$global:CccHyperVJsonInput');
        expect(source).not.toContain('[Console]::In.ReadToEnd()');
        expect(source).toContain("Get-VMHardDiskDrive");
        expect(source).toContain("Get-VMDvdDrive");
        expect(source).toContain("Start-VM");
        expect(source).toContain("Stop-VM");
        expect(source).not.toMatch(/Stop-VM[^\r\n]*-Shutdown/);
        expect(source).toContain("Remove-VM -VM $VirtualMachine");
        expect(source).not.toContain("Remove-Item");
        expect(source).not.toContain("Get-VM -Id ([Guid][string]$Selector.id) -ErrorAction SilentlyContinue");
        expect(source).toContain("Get-VM -ErrorAction Stop | Where-Object");
        expect(source).not.toContain('CategoryInfo.Category -eq "ObjectNotFound"');
        expect(source).not.toContain("CommandNotFoundException");
        expect(source).toContain("Get-VMHardDiskDrive -VM $VirtualMachine -ErrorAction Stop");
        expect(source).toContain("Get-VMDvdDrive -VM $VirtualMachine -ErrorAction Stop");
        // Every VM-scoped operation resolves exactly one virtual machine before touching it,
        // and Get-VM itself is the only exception. The count rises with each such operation:
        // the disk, DVD and snapshot reads, start, stop, remove, checkpoint, snapshot removal
        // and restore, plus the VM-scoped adapter read and the adapter removal -- and, from
        // the creation slice, the VM/memory/processor/BIOS settings, the firmware read and
        // write, and the adapter add, rename and address.
        //
        // New-VM is deliberately absent: it is the call that brings the VM into existence, so
        // there is nothing to resolve. If it ever appears in this count, it has been given a
        // selector it cannot have.
        expect(source.match(/\$VirtualMachine = Assert-HyperVWindowsSingleVirtualMachine \$VirtualMachines/g))
            .toHaveLength(20);
        expect(source).toContain("Get-VMSnapshot -VM $VirtualMachine -ErrorAction Stop");
        expect(source).toContain("Checkpoint-VM -VM $VirtualMachine -SnapshotName $SnapshotName -Passthru -ErrorAction Stop");
        expect(source).toContain("Remove-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop");
        expect(source).toContain("Remove-VMSnapshot -VMSnapshot $Snapshot -IncludeAllChildSnapshots -Confirm:$false -ErrorAction Stop");
        expect(source).toContain("Restore-VMSnapshot -VMSnapshot $Snapshot -Confirm:$false -ErrorAction Stop");
        // Snapshot resolution is exact-match only, with no consumer naming convention baked in.
        expect(source).toContain('if ($Matched.Count -eq 0) { throw "snapshot-not-found" }');
        expect(source).toContain('if ($Matched.Count -ne 1) { throw "snapshot-selector-ambiguous" }');
        expect(source).not.toContain("ccc-");
        expect(HYPER_V_POWERSHELL_MANIFEST.operations["windows-operation"].script).toBe(basename(fileRequest.scriptPath));
        expect(HYPER_V_POWERSHELL_MANIFEST.assets[HYPER_V_WINDOWS_POWERSHELL_ASSET.name].sha256)
            .toBe(HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256);
    });

    it("accepts only an integrity-pinned embedded operation asset", async () => {
        const assetPath = join(process.cwd(), "scripts", "host-control", "hyper-v", HYPER_V_WINDOWS_POWERSHELL_ASSET.name);
        const scriptSource = readFileSync(assetPath, "utf8");
        const run = vi.fn(() => response("Get-VM"));
        const request: HyperVWindowsExecutionRequest = {
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "id", id: canonicalVmId },
        };
        const embedded = createHyperVWindowsPowerShellExecutor({
            executable: "powershell.exe",
            run,
            operationAsset: { scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1", scriptSource },
        });
        await embedded.execute(request, { timeoutMilliseconds: 1, maximumOutputBytes: 1 });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1",
            scriptSource,
        }), expect.any(Object));

        const tampered = createHyperVWindowsPowerShellExecutor({
            executable: "powershell.exe",
            run,
            operationAsset: { scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1", scriptSource: `${scriptSource}\n# tampered` },
        });
        expect(() => tampered.execute(request, { timeoutMilliseconds: 1, maximumOutputBytes: 1 }))
            .toThrow("hyper-v-windows-powershell-asset-integrity-failed");
    });
});

// The ten creation primitives. `normalizeAdapterTarget` in particular arrived with five error
// paths and no coverage at all, while being the thing that keeps the rename off a literal
// adapter name -- which is wrong on any localized Hyper-V. `getVMFirmware` was the tenth and
// was missed on the first pass: the block claimed ten and exercised nine, so
// `parseVirtualMachineFirmware` could swap its two Secure Boot fields and stay green.
describe("Hyper-V Windows creation primitives", () => {
    function recordingClient(): { client: ReturnType<typeof createHyperVWindowsClient>; requests: HyperVWindowsExecutionRequest[] } {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const client = createHyperVWindowsClient(executorUsing((request) => {
            requests.push(request);
            if (request.operation === "New-VM") return response(request.operation, [virtualMachine]);
            if (request.operation === "Get-VMFirmware") return response(request.operation, [virtualMachineFirmware]);
            return response(request.operation, []);
        }));
        return { client, requests };
    }

    it("sends one native operation per method, with normalized parameters", async () => {
        const { client, requests } = recordingClient();
        await client.newVM({ name: "vm", generation: 2, memoryStartupBytes: 2 * 1024 * 1024 * 1024, vhdPath: "C:\\d\\r.vhdx" });
        await client.setVM({ selector, notes: "marker", checkpointType: "ProductionOnly" });
        await client.setVMMemory({ selector, dynamicMemoryEnabled: false });
        await client.setVMProcessor({ selector, count: 4 });
        await client.getVMFirmware(selector);
        await client.setVMFirmware({ selector, secureBoot: { enabled: true, template: "MicrosoftWindows" } });
        await client.setVMBios({ selector, startupOrder: ["IDE", "CD"] });
        await client.addVMNetworkAdapter({ selector, name: "CCC Device Network", switchName: "ccc-internal" });
        await client.renameVMNetworkAdapter({ selector, adapter: { kind: "sole" }, newName: "CCC Bootstrap DHCP" });
        await client.setVMNetworkAdapter({
            selector,
            adapter: { kind: "name", name: "CCC Bootstrap DHCP" },
            // Accepted in any spelling and canonicalized to the bare uppercase hex native wants.
            staticMacAddress: "06:15:5d:01:1a:2c",
        });

        // Every wire field of every call, not the operation names plus a spot check. The name
        // is the one part a wrong parameter never changes: a Set-VMProcessor that hardcodes
        // one vCPU, or a Set-VM that drops automaticCheckpointsEnabled, still sends exactly
        // "Set-VMProcessor" and "Set-VM". Pinning the sequence and two of ten objects left
        // seven able to send anything -- the same shape-not-content gap that let the creation
        // plan attach the shared golden base image, one layer down.
        const id = { kind: "id", id: canonicalVmId };
        expect(requests).toEqual([
            // New-VM carries no selector: it is the call that brings the VM into existence.
            {
                schemaVersion: 1,
                operation: "New-VM",
                name: "vm",
                generation: 2,
                memoryStartupBytes: 2 * 1024 * 1024 * 1024,
                vhdPath: "C:\\d\\r.vhdx",
            },
            {
                schemaVersion: 1,
                operation: "Set-VM",
                selector: id,
                notes: "marker",
                checkpointType: "ProductionOnly",
            },
            { schemaVersion: 1, operation: "Set-VMMemory", selector: id, dynamicMemoryEnabled: false },
            { schemaVersion: 1, operation: "Set-VMProcessor", selector: id, count: 4 },
            { schemaVersion: 1, operation: "Get-VMFirmware", selector: id },
            {
                schemaVersion: 1,
                operation: "Set-VMFirmware",
                selector: id,
                secureBoot: { enabled: true, template: "MicrosoftWindows" },
            },
            { schemaVersion: 1, operation: "Set-VMBios", selector: id, startupOrder: ["IDE", "CD"] },
            {
                schemaVersion: 1,
                operation: "Add-VMNetworkAdapter",
                selector: id,
                name: "CCC Device Network",
                switchName: "ccc-internal",
            },
            {
                schemaVersion: 1,
                operation: "Rename-VMNetworkAdapter",
                selector: id,
                adapter: { kind: "sole" },
                newName: "CCC Bootstrap DHCP",
            },
            {
                schemaVersion: 1,
                operation: "Set-VMNetworkAdapter",
                selector: id,
                adapter: { kind: "name", name: "CCC Bootstrap DHCP" },
                staticMacAddress: "06155D011A2C",
            },
        ]);
    });

    // Omitting a field and sending it are different wire shapes, and the optional ones are
    // where a drop hides: Set-VM applies only the parameters it is given, so a client that
    // quietly loses one reports success for settings it never sent.
    it("sends exactly the optional fields it was given, and no key for the rest", async () => {
        const { client, requests } = recordingClient();
        await client.setVM({ selector, automaticCheckpointsEnabled: false });
        await client.setVMFirmware({ selector, secureBoot: { enabled: false }, firstBootDiskPath: "C:\\d\\r.vhdx" });

        expect(requests).toEqual([
            {
                schemaVersion: 1,
                operation: "Set-VM",
                selector: { kind: "id", id: canonicalVmId },
                automaticCheckpointsEnabled: false,
            },
            {
                schemaVersion: 1,
                operation: "Set-VMFirmware",
                selector: { kind: "id", id: canonicalVmId },
                secureBoot: { enabled: false },
                firstBootDiskPath: "C:\\d\\r.vhdx",
            },
        ]);
    });

    it("returns the VM native created, so later steps need not re-find it by name", async () => {
        const { client } = recordingClient();
        await expect(client.newVM({ name: "vm", generation: 2, memoryStartupBytes: 2 * 1024 * 1024 * 1024 }))
            .resolves.toMatchObject({ id: canonicalVmId, name: "library-test" });
    });

    // This is the read that answers "does this VM boot from my disk". Decoding it into the
    // wrong fields is silent: both are opaque native strings, so a swap type-checks and only
    // shows up as a boot-order verification that passes on a VM that boots from the network.
    it("decodes firmware into the fields it names", async () => {
        const { client } = recordingClient();
        await expect(client.getVMFirmware(selector)).resolves.toEqual({
            vmId: canonicalVmId,
            secureBoot: "On",
            secureBootTemplate: "MicrosoftWindows",
            firstBootDevicePath: "C:\\devices\\device-1\\root.vhdx",
        });
    });

    // Absent is a real answer, not a decode failure: a VM whose first boot entry is a network
    // or DVD device has no path. A caller must be able to tell that apart from a path that
    // failed to decode, which is why null passes and an empty string does not.
    it("accepts a null first boot device path and refuses an empty one", async () => {
        const firmwareReturning = (item: unknown) => createHyperVWindowsClient(executorUsing(
            (request) => response(request.operation, [item]),
        ));

        await expect(firmwareReturning({ ...virtualMachineFirmware, firstBootDevicePath: null })
            .getVMFirmware(selector)).resolves.toMatchObject({ firstBootDevicePath: null });
        await expect(firmwareReturning({ ...virtualMachineFirmware, firstBootDevicePath: "" })
            .getVMFirmware(selector)).rejects.toThrow(/result-shape-invalid/);
    });

    it.each([
        ["a missing key", { vmId, secureBoot: "On", secureBootTemplate: "MicrosoftWindows" }],
        ["an extra key", { ...virtualMachineFirmware, extra: "x" }],
        ["a vmId that is not a GUID", { ...virtualMachineFirmware, vmId: "not-a-guid" }],
        ["an empty secureBoot", { ...virtualMachineFirmware, secureBoot: "" }],
        ["a non-string secureBootTemplate", { ...virtualMachineFirmware, secureBootTemplate: 2 }],
    ])("refuses firmware carrying %s rather than decoding it partly", async (_label, item) => {
        const client = createHyperVWindowsClient(executorUsing((request) => response(request.operation, [item])));
        await expect(client.getVMFirmware(selector)).rejects.toThrow(/result-shape-invalid/);
    });

    // Native rejects a template alongside Secure Boot off, and rejects an empty one when it is
    // on. Both fail here instead, so the caller learns before a process launch.
    it.each([
        ["a setting that is not an object", "on"],
        ["a non-boolean enabled", { enabled: "yes" }],
        ["disabled carrying a template", { enabled: false, template: "MicrosoftWindows" }],
        ["enabled with no template", { enabled: true }],
        ["enabled with an empty template", { enabled: true, template: "" }],
        ["enabled with a wildcard template", { enabled: true, template: "Microsoft*" }],
    ])("refuses Secure Boot as %s before reaching the host", async (_label, secureBoot) => {
        const { client, requests } = recordingClient();
        await expect(client.setVMFirmware({ selector, secureBoot: secureBoot as never }))
            .rejects.toThrow(/secure-boot/);
        expect(requests).toHaveLength(0);
    });

    it.each([
        ["a target that is not an object", "hello"],
        ["a target with no kind", {}],
        ["an unknown kind", { kind: "first" }],
        ["a sole target carrying extra keys", { kind: "sole", name: "x" }],
        ["a named target with no name", { kind: "name" }],
        ["a named target whose name is a wildcard", { kind: "name", name: "CCC *" }],
        ["a named target whose name is empty", { kind: "name", name: "" }],
    ])("refuses %s before reaching the host", async (_label, adapter) => {
        const { client, requests } = recordingClient();
        await expect(client.renameVMNetworkAdapter({
            selector,
            adapter: adapter as never,
            newName: "CCC Bootstrap DHCP",
        })).rejects.toThrow(/adapter-target/);
        expect(requests).toHaveLength(0);
    });

    // Native accepts it, but a caller asking for it has confused two adapters or two states of
    // one. Only checkable when the target names one -- `sole` does not know its own name yet.
    it("refuses a rename to the name the adapter already has", async () => {
        const { client } = recordingClient();
        await expect(client.renameVMNetworkAdapter({
            selector,
            adapter: { kind: "name", name: "CCC Bootstrap DHCP" },
            newName: "CCC Bootstrap DHCP",
        })).rejects.toThrow("new-name-unchanged");
    });

    it.each([
        ["a Set-VM naming no setting at all", () => ({ selector })],
        ["a processor count of zero", () => ({ selector, count: 0 })],
    ])("refuses %s", async (_label, build) => {
        const { client, requests } = recordingClient();
        const request = build() as never;
        await expect("count" in (request as object)
            ? client.setVMProcessor(request)
            : client.setVM(request)).rejects.toThrow();
        expect(requests).toHaveLength(0);
    });

    it.each([
        ["the all-zero address, which is native's not-assigned-yet placeholder", "00:00:00:00:00:00"],
        ["an address that is not twelve hex digits", "06:15:5d:01:1a"],
    ])("refuses %s as a static MAC", async (_label, staticMacAddress) => {
        const { client } = recordingClient();
        await expect(client.setVMNetworkAdapter({
            selector,
            adapter: { kind: "sole" },
            staticMacAddress,
        })).rejects.toThrow(/static-mac-address/);
    });

    it("refuses a BIOS startup order that repeats a device", async () => {
        const { client } = recordingClient();
        await expect(client.setVMBios({ selector, startupOrder: ["IDE", "IDE"] }))
            .rejects.toThrow("startup-order-duplicated");
    });
});
