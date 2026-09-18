import type {
    HyperVAddVMNetworkAdapterRequest,
    HyperVBiosStartupDevice,
    HyperVCheckpointVirtualMachineRequest,
    HyperVDvdDrive,
    HyperVHardDiskDrive,
    HyperVNewVirtualMachineRequest,
    HyperVRemoveSnapshotRequest,
    HyperVRemoveVirtualMachineRequest,
    HyperVRenameVMNetworkAdapterRequest,
    HyperVRestoreSnapshotRequest,
    HyperVSecureBootSetting,
    HyperVSetVirtualMachineRequest,
    HyperVSetVMBiosRequest,
    HyperVSetVMFirmwareRequest,
    HyperVSetVMMemoryRequest,
    HyperVSetVMNetworkAdapterRequest,
    HyperVSetVMProcessorRequest,
    HyperVSnapshotSelector,
    HyperVStartVirtualMachineRequest,
    HyperVStopVirtualMachineRequest,
    HyperVVirtualMachine,
    HyperVVirtualMachineFirmware,
    HyperVVMNetworkAdapterTarget,
    HyperVVirtualMachineSelector,
    HyperVVirtualMachineSnapshot,
    HyperVWindowsCallOptions,
    HyperVWindowsClient,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
    HyperVWindowsOperation,
} from "./contracts.js";
import { HyperVWindowsError } from "./errors.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EXECUTION_TIMEOUT_MILLISECONDS = 120 * 1000;
const MAX_NAME_LENGTH = 100;
const MAX_NATIVE_STRING_LENGTH = 32 * 1024;
// The wildcard characters the Hyper-V cmdlets treat as patterns rather than literals.
const NATIVE_NAME_WILDCARDS = ["*", "?", "[", "]"];

type SuccessEnvelope = {
    schemaVersion: 1;
    operation: HyperVWindowsOperation;
    ok: true;
    items: unknown[];
};

function error(
    category: "validation" | "transport" | "protocol" | "native",
    operation: HyperVWindowsOperation,
    code: string,
    nativeStatus?: number,
): HyperVWindowsError {
    return new HyperVWindowsError({ category, operation, code, ...(nativeStatus === undefined ? {} : { nativeStatus }) });
}

// Exported for the network client, which addresses VMs the same way and must not carry a
// second copy of this: it validates the target of Remove-VMNetworkAdapter, and two copies of
// destructive-target validation are two things that can drift apart. Not re-exported from
// the package index -- it is internal to the low-level layer.
export function normalizeSelector(
    operation: HyperVWindowsOperation,
    selector: HyperVVirtualMachineSelector,
): HyperVVirtualMachineSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "selector-invalid");
    if (candidate.kind === "id") {
        if (!hasExactKeys(candidate, ["kind", "id"])) throw error("validation", operation, "selector-invalid");
        if (typeof candidate.id !== "string" || !GUID_PATTERN.test(candidate.id)) {
            throw error("validation", operation, "selector-id-invalid");
        }
        return { kind: "id", id: candidate.id.toLowerCase() };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "selector-invalid");
        if (typeof candidate.name !== "string"
            || candidate.name.length === 0
            || candidate.name.length > MAX_NAME_LENGTH
            || /[\u0000-\u001f*?\[\]]/.test(candidate.name)) {
            throw error("validation", operation, "selector-name-invalid");
        }
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "selector-kind-invalid");
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, allowEmpty = true): value is string {
    return typeof value === "string"
        && (allowEmpty || value.length > 0)
        && value.length <= MAX_NATIVE_STRING_LENGTH
        && !value.includes("\u0000");
}

function safeInteger(value: unknown, minimum = 0): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function canonicalGuid(value: unknown): string | null {
    return typeof value === "string" && GUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function parseVirtualMachine(value: unknown): HyperVVirtualMachine | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "id", "name", "state", "status", "notes", "uptimeMilliseconds", "generation", "checkpointType",
    ])) return null;
    const id = canonicalGuid(item.id);
    if (!id
        || !boundedString(item.name, false)
        || !boundedString(item.state, false)
        || !boundedString(item.status)
        || !boundedString(item.notes)
        || !safeInteger(item.uptimeMilliseconds)
        || !safeInteger(item.generation, 1)
        || !boundedString(item.checkpointType)) return null;
    return {
        id,
        name: item.name,
        state: item.state,
        status: item.status,
        notes: item.notes,
        uptimeMilliseconds: item.uptimeMilliseconds,
        generation: item.generation,
        checkpointType: item.checkpointType,
    };
}

function parseNullablePath(value: unknown): string | null | undefined {
    if (value === null) return null;
    return boundedString(value, false) ? value : undefined;
}

function parseHardDiskDrive(value: unknown): HyperVHardDiskDrive | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "vmId", "vmName", "path", "controllerType", "controllerNumber", "controllerLocation", "diskNumber",
    ])) return null;
    const vmId = canonicalGuid(item.vmId);
    const path = parseNullablePath(item.path);
    if (!vmId
        || !boundedString(item.vmName, false)
        || path === undefined
        || !boundedString(item.controllerType, false)
        || !safeInteger(item.controllerNumber)
        || !safeInteger(item.controllerLocation)
        || (item.diskNumber !== null && !safeInteger(item.diskNumber))) return null;
    return {
        vmId,
        vmName: item.vmName,
        path,
        controllerType: item.controllerType,
        controllerNumber: item.controllerNumber,
        controllerLocation: item.controllerLocation,
        diskNumber: item.diskNumber as number | null,
    };
}

function parseDvdDrive(value: unknown): HyperVDvdDrive | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "vmId", "vmName", "path", "controllerType", "controllerNumber", "controllerLocation",
    ])) return null;
    const vmId = canonicalGuid(item.vmId);
    const path = parseNullablePath(item.path);
    if (!vmId
        || !boundedString(item.vmName, false)
        || path === undefined
        || !boundedString(item.controllerType, false)
        || !safeInteger(item.controllerNumber)
        || !safeInteger(item.controllerLocation)) return null;
    return {
        vmId,
        vmName: item.vmName,
        path,
        controllerType: item.controllerType,
        controllerNumber: item.controllerNumber,
        controllerLocation: item.controllerLocation,
    };
}

function parseSnapshot(value: unknown): HyperVVirtualMachineSnapshot | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, [
        "id", "name", "vmId", "vmName", "snapshotType",
        "parentSnapshotId", "parentSnapshotName", "creationTimeMilliseconds",
    ])) return null;
    const id = canonicalGuid(item.id);
    const vmId = canonicalGuid(item.vmId);
    // A root checkpoint has no parent, so null is a real value here rather than a decode failure.
    const parentSnapshotId = item.parentSnapshotId === null ? null : canonicalGuid(item.parentSnapshotId);
    if (!id
        || !vmId
        || !boundedString(item.name, false)
        || !boundedString(item.vmName, false)
        || !boundedString(item.snapshotType, false)
        || (item.parentSnapshotId !== null && !parentSnapshotId)
        || (item.parentSnapshotName !== null && !boundedString(item.parentSnapshotName, false))
        || !safeInteger(item.creationTimeMilliseconds)) return null;
    return {
        id,
        name: item.name,
        vmId,
        vmName: item.vmName,
        snapshotType: item.snapshotType,
        parentSnapshotId,
        parentSnapshotName: item.parentSnapshotName as string | null,
        creationTimeMilliseconds: item.creationTimeMilliseconds,
    };
}

// Snapshot names carry the same native restrictions as virtual machine names: non-empty, bounded,
// no control characters, and no cmdlet wildcard characters.
function validNativeName(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME_LENGTH) return false;
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint < 0x20) return false;
        if (NATIVE_NAME_WILDCARDS.includes(character)) return false;
    }
    return true;
}

function normalizeSnapshotSelector(
    operation: HyperVWindowsOperation,
    selector: HyperVSnapshotSelector,
): HyperVSnapshotSelector {
    const candidate = record(selector);
    if (!candidate) throw error("validation", operation, "snapshot-selector-invalid");
    if (candidate.kind === "id") {
        if (!hasExactKeys(candidate, ["kind", "id"])) throw error("validation", operation, "snapshot-selector-invalid");
        if (typeof candidate.id !== "string" || !GUID_PATTERN.test(candidate.id)) {
            throw error("validation", operation, "snapshot-selector-id-invalid");
        }
        return { kind: "id", id: candidate.id.toLowerCase() };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "snapshot-selector-invalid");
        if (!validNativeName(candidate.name)) throw error("validation", operation, "snapshot-selector-name-invalid");
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "snapshot-selector-kind-invalid");
}

function decodeEnvelope(
    operation: HyperVWindowsOperation,
    execution: HyperVWindowsExecutionResult,
): SuccessEnvelope {
    if (execution.outputLimitExceeded || Buffer.byteLength(execution.stdout, "utf8") > MAX_RESPONSE_BYTES) {
        throw error("protocol", operation, "response-too-large");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(execution.stdout.trim());
    } catch {
        throw error("protocol", operation, "response-malformed");
    }
    const envelope = record(parsed);
    if (!envelope || envelope.schemaVersion !== 1 || envelope.operation !== operation || typeof envelope.ok !== "boolean") {
        throw error("protocol", operation, "response-envelope-invalid");
    }
    if (envelope.ok === false) {
        if (!hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "errorCode"])
            || typeof envelope.errorCode !== "string"
            || !NATIVE_ERROR_CODE_PATTERN.test(envelope.errorCode)) {
            throw error("protocol", operation, "response-envelope-invalid");
        }
        throw error("native", operation, envelope.errorCode, execution.status ?? undefined);
    }
    if (!hasExactKeys(envelope, ["schemaVersion", "operation", "ok", "items"]) || !Array.isArray(envelope.items)) {
        throw error("protocol", operation, "response-envelope-invalid");
    }
    if (execution.status !== 0) throw error("protocol", operation, "response-status-conflict");
    return envelope as SuccessEnvelope;
}

async function execute(
    executor: HyperVWindowsExecutor,
    request: HyperVWindowsExecutionRequest,
    options?: HyperVWindowsCallOptions,
): Promise<SuccessEnvelope> {
    if (options?.signal?.aborted) throw error("transport", request.operation, "cancelled");
    let execution: HyperVWindowsExecutionResult;
    try {
        execution = await executor.execute(request, {
            timeoutMilliseconds: EXECUTION_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: MAX_RESPONSE_BYTES,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
    } catch (cause) {
        const code = cause instanceof Error && cause.name === "AbortError" ? "cancelled" : "executor-failed";
        throw error("transport", request.operation, code);
    }
    if (!execution || typeof execution !== "object"
        || (execution.status !== null && !Number.isInteger(execution.status))
        || typeof execution.stdout !== "string") {
        throw error("transport", request.operation, "executor-result-invalid");
    }
    if (execution.outputLimitExceeded) throw error("protocol", request.operation, "response-too-large");
    if (execution.cancelled) throw error("transport", request.operation, "cancelled");
    if (execution.timedOut) throw error("transport", request.operation, "timeout");
    if (execution.error || execution.status === null) throw error("transport", request.operation, "executor-failed");
    return decodeEnvelope(request.operation, execution);
}

function decodeItems<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    decoder: (value: unknown) => T | null,
): readonly T[] {
    if (envelope.items.length > 4096) throw error("protocol", operation, "result-count-exceeded");
    const decoded = envelope.items.map(decoder);
    if (decoded.some((item) => item === null)) throw error("protocol", operation, "result-shape-invalid");
    return decoded as T[];
}

function expectNoItems(operation: HyperVWindowsOperation, envelope: SuccessEnvelope): void {
    if (envelope.items.length !== 0) throw error("protocol", operation, "result-ambiguous");
}

const BIOS_STARTUP_DEVICES: readonly HyperVBiosStartupDevice[] = ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"];
// Hyper-V's own floor. Below it native refuses, and a request that cannot succeed should fail
// here rather than after a process launch.
const MINIMUM_MEMORY_BYTES = 32 * 1024 * 1024;
// Hyper-V's own per-VM ceiling. Like the memory floor above it this is a native fact, not a
// consumer policy: a request above it cannot succeed, so it fails here rather than after a
// process launch.
const MAXIMUM_PROCESSOR_COUNT = 512;

function parseVirtualMachineFirmware(value: unknown): HyperVVirtualMachineFirmware | null {
    const item = record(value);
    if (!item || !hasExactKeys(item, ["vmId", "secureBoot", "secureBootTemplate", "firstBootDevicePath"])) return null;
    const vmId = canonicalGuid(item.vmId);
    if (!vmId || !boundedString(item.secureBoot, false) || !boundedString(item.secureBootTemplate)) return null;
    // Absent is a real answer here: the first boot entry may be a network or DVD device, which
    // has no path. A caller checking "does the VM boot from my disk" must be able to tell that
    // apart from a path that failed to decode, so only null and a usable string are accepted.
    if (item.firstBootDevicePath !== null && !boundedString(item.firstBootDevicePath, false)) return null;
    return {
        vmId,
        secureBoot: item.secureBoot,
        secureBootTemplate: item.secureBootTemplate,
        firstBootDevicePath: item.firstBootDevicePath as string | null,
    };
}

// Secure Boot off carries no template, because native rejects one. Validating the pair here
// keeps the client from sending a combination the host will only reject after a process launch.
function normalizeSecureBoot(
    operation: HyperVWindowsOperation,
    setting: HyperVSecureBootSetting,
): HyperVSecureBootSetting {
    const candidate = record(setting);
    if (!candidate) throw error("validation", operation, "secure-boot-invalid");
    if (candidate.enabled === false) {
        if (!hasExactKeys(candidate, ["enabled"])) throw error("validation", operation, "secure-boot-invalid");
        return { enabled: false };
    }
    if (candidate.enabled === true) {
        if (!hasExactKeys(candidate, ["enabled", "template"])) throw error("validation", operation, "secure-boot-invalid");
        if (!validNativeName(candidate.template)) throw error("validation", operation, "secure-boot-template-invalid");
        return { enabled: true, template: candidate.template };
    }
    throw error("validation", operation, "secure-boot-invalid");
}

// The adapter New-VM creates carries a display-language name, so a literal for it is wrong on
// a localized host. `sole` says "the VM's only adapter" and resolves only when that is true --
// the same assertion the PowerShell this replaces made before it took index 0.
function normalizeAdapterTarget(
    operation: HyperVWindowsOperation,
    target: HyperVVMNetworkAdapterTarget,
): HyperVVMNetworkAdapterTarget {
    const candidate = record(target);
    if (!candidate) throw error("validation", operation, "adapter-target-invalid");
    if (candidate.kind === "sole") {
        if (!hasExactKeys(candidate, ["kind"])) throw error("validation", operation, "adapter-target-invalid");
        return { kind: "sole" };
    }
    if (candidate.kind === "name") {
        if (!hasExactKeys(candidate, ["kind", "name"])) throw error("validation", operation, "adapter-target-invalid");
        if (!validNativeName(candidate.name)) throw error("validation", operation, "adapter-target-name-invalid");
        return { kind: "name", name: candidate.name };
    }
    throw error("validation", operation, "adapter-target-kind-invalid");
}

function decodeSingleItem<T>(
    operation: HyperVWindowsOperation,
    envelope: SuccessEnvelope,
    decoder: (value: unknown) => T | null,
): T {
    if (envelope.items.length !== 1) throw error("protocol", operation, "result-ambiguous");
    const decoded = decoder(envelope.items[0]);
    if (decoded === null) throw error("protocol", operation, "result-shape-invalid");
    return decoded;
}

export function createHyperVWindowsClient(executor: HyperVWindowsExecutor): HyperVWindowsClient {
    return {
        async getVM(selector, options) {
            const operation = "Get-VM";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseVirtualMachine);
        },
        async getVMHardDiskDrives(selector, options) {
            const operation = "Get-VMHardDiskDrive";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseHardDiskDrive);
        },
        async getVMDvdDrives(selector, options) {
            const operation = "Get-VMDvdDrive";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseDvdDrive);
        },
        async startVM(request: HyperVStartVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Start-VM";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
            }, options);
            expectNoItems(operation, envelope);
        },
        async stopVM(request: HyperVStopVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Stop-VM";
            if (!request || (request.mode !== "shutdown" && request.mode !== "turn-off")) {
                throw error("validation", operation, "mode-invalid");
            }
            if (request.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                mode: request.mode,
                force: request.force ?? false,
            }, options);
            expectNoItems(operation, envelope);
        },
        async removeVM(request: HyperVRemoveVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VM";
            if (request?.force !== undefined && typeof request.force !== "boolean") {
                throw error("validation", operation, "force-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                force: request.force ?? false,
            }, options);
            expectNoItems(operation, envelope);
        },
        async getVMSnapshots(selector, options) {
            const operation = "Get-VMSnapshot";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeItems(operation, envelope, parseSnapshot);
        },
        async checkpointVM(request: HyperVCheckpointVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Checkpoint-VM";
            if (!request || !validNativeName(request.snapshotName)) {
                throw error("validation", operation, "snapshot-name-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                snapshotName: request.snapshotName,
            }, options);
            return decodeSingleItem(operation, envelope, parseSnapshot);
        },
        async removeVMSnapshot(request: HyperVRemoveSnapshotRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Remove-VMSnapshot";
            if (request?.includeDescendants !== undefined && typeof request.includeDescendants !== "boolean") {
                throw error("validation", operation, "include-descendants-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                snapshot: normalizeSnapshotSelector(operation, request.snapshot),
                includeDescendants: request.includeDescendants ?? false,
            }, options);
            expectNoItems(operation, envelope);
        },
        async restoreVMSnapshot(request: HyperVRestoreSnapshotRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Restore-VMSnapshot";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request?.selector),
                snapshot: normalizeSnapshotSelector(operation, request?.snapshot),
            }, options);
            expectNoItems(operation, envelope);
        },
        async newVM(request: HyperVNewVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "New-VM";
            if (!request || !validNativeName(request.name)) throw error("validation", operation, "name-invalid");
            if (request.generation !== 1 && request.generation !== 2) {
                throw error("validation", operation, "generation-invalid");
            }
            if (!safeInteger(request.memoryStartupBytes, MINIMUM_MEMORY_BYTES)) {
                throw error("validation", operation, "memory-startup-bytes-invalid");
            }
            if (request.vhdPath !== undefined && !boundedString(request.vhdPath, false)) {
                throw error("validation", operation, "vhd-path-invalid");
            }
            if (request.switchName !== undefined && !validNativeName(request.switchName)) {
                throw error("validation", operation, "switch-name-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                name: request.name,
                generation: request.generation,
                memoryStartupBytes: request.memoryStartupBytes,
                ...(request.vhdPath === undefined ? {} : { vhdPath: request.vhdPath }),
                ...(request.switchName === undefined ? {} : { switchName: request.switchName }),
            }, options);
            // Decoded, not assumed: the id native assigns is what every following step selects
            // by, so reading it back from the creating call is what keeps the rest of creation
            // from having to re-find the VM by a name that is not unique until it exists.
            return decodeSingleItem(operation, envelope, parseVirtualMachine);
        },
        async setVM(request: HyperVSetVirtualMachineRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VM";
            if (!request) throw error("validation", operation, "request-invalid");
            if (request.notes !== undefined && !boundedString(request.notes)) {
                throw error("validation", operation, "notes-invalid");
            }
            if (request.automaticCheckpointsEnabled !== undefined
                && typeof request.automaticCheckpointsEnabled !== "boolean") {
                throw error("validation", operation, "automatic-checkpoints-enabled-invalid");
            }
            if (request.checkpointType !== undefined
                && !["Disabled", "Production", "ProductionOnly", "Standard"].includes(request.checkpointType)) {
                throw error("validation", operation, "checkpoint-type-invalid");
            }
            // Native applies only the parameters it is given, so a request naming none of them
            // is a call that mutates nothing. Refusing it keeps a caller from reading success
            // as "the settings I meant were applied".
            if (request.notes === undefined
                && request.automaticCheckpointsEnabled === undefined
                && request.checkpointType === undefined) {
                throw error("validation", operation, "request-empty");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                ...(request.notes === undefined ? {} : { notes: request.notes }),
                ...(request.automaticCheckpointsEnabled === undefined
                    ? {}
                    : { automaticCheckpointsEnabled: request.automaticCheckpointsEnabled }),
                ...(request.checkpointType === undefined ? {} : { checkpointType: request.checkpointType }),
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMMemory(request: HyperVSetVMMemoryRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMMemory";
            if (!request || typeof request.dynamicMemoryEnabled !== "boolean") {
                throw error("validation", operation, "dynamic-memory-enabled-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                dynamicMemoryEnabled: request.dynamicMemoryEnabled,
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMProcessor(request: HyperVSetVMProcessorRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMProcessor";
            if (!request || !safeInteger(request.count, 1) || request.count > MAXIMUM_PROCESSOR_COUNT) {
                throw error("validation", operation, "count-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                count: request.count,
            }, options);
            expectNoItems(operation, envelope);
        },
        async getVMFirmware(selector: HyperVVirtualMachineSelector, options?: HyperVWindowsCallOptions) {
            const operation = "Get-VMFirmware";
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, selector),
            }, options);
            return decodeSingleItem(operation, envelope, parseVirtualMachineFirmware);
        },
        async setVMFirmware(request: HyperVSetVMFirmwareRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMFirmware";
            if (!request) throw error("validation", operation, "request-invalid");
            if (request.firstBootDiskPath !== undefined && !boundedString(request.firstBootDiskPath, false)) {
                throw error("validation", operation, "first-boot-disk-path-invalid");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                secureBoot: normalizeSecureBoot(operation, request.secureBoot),
                ...(request.firstBootDiskPath === undefined ? {} : { firstBootDiskPath: request.firstBootDiskPath }),
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMBios(request: HyperVSetVMBiosRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMBios";
            if (!request || !Array.isArray(request.startupOrder) || request.startupOrder.length === 0) {
                throw error("validation", operation, "startup-order-invalid");
            }
            for (const device of request.startupOrder) {
                if (!BIOS_STARTUP_DEVICES.includes(device)) {
                    throw error("validation", operation, "startup-order-device-invalid");
                }
            }
            // Native keeps the order given and ignores a repeat, so a duplicate means the
            // caller believes it asked for something the host will not do.
            if (new Set(request.startupOrder).size !== request.startupOrder.length) {
                throw error("validation", operation, "startup-order-duplicated");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                startupOrder: [...request.startupOrder],
            }, options);
            expectNoItems(operation, envelope);
        },
        async addVMNetworkAdapter(request: HyperVAddVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Add-VMNetworkAdapter";
            if (!request || !validNativeName(request.name)) throw error("validation", operation, "name-invalid");
            if (!validNativeName(request.switchName)) throw error("validation", operation, "switch-name-invalid");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                name: request.name,
                switchName: request.switchName,
            }, options);
            expectNoItems(operation, envelope);
        },
        async renameVMNetworkAdapter(request: HyperVRenameVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Rename-VMNetworkAdapter";
            if (!request || !validNativeName(request.newName)) throw error("validation", operation, "new-name-invalid");
            const adapter = normalizeAdapterTarget(operation, request.adapter);
            // A rename to the name it already has is not a rename. Native accepts it, but the
            // caller asking for it has confused two adapters or two states of one. Only
            // checkable when the target names one; `sole` does not know its own name yet.
            if (adapter.kind === "name" && adapter.name === request.newName) {
                throw error("validation", operation, "new-name-unchanged");
            }
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                adapter,
                newName: request.newName,
            }, options);
            expectNoItems(operation, envelope);
        },
        async setVMNetworkAdapter(request: HyperVSetVMNetworkAdapterRequest, options?: HyperVWindowsCallOptions) {
            const operation = "Set-VMNetworkAdapter";
            if (!request) throw error("validation", operation, "request-invalid");
            const adapter = normalizeAdapterTarget(operation, request.adapter);
            // Canonicalised to bare uppercase hex, which is the only spelling native accepts
            // for -StaticMacAddress. The all-zero address is refused: native reports it for an
            // adapter with no address yet, so setting it would be asking for that state rather
            // than for an address.
            const macAddress = typeof request.staticMacAddress === "string"
                ? request.staticMacAddress.replace(/[:-]/g, "").toUpperCase()
                : "";
            if (!/^[0-9A-F]{12}$/.test(macAddress)) throw error("validation", operation, "static-mac-address-invalid");
            if (macAddress === "000000000000") throw error("validation", operation, "static-mac-address-unassigned");
            const envelope = await execute(executor, {
                schemaVersion: 1,
                operation,
                selector: normalizeSelector(operation, request.selector),
                adapter,
                staticMacAddress: macAddress,
            }, options);
            expectNoItems(operation, envelope);
        },
    };
}
