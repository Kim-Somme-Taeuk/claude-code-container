import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP } from "@ccc/hyper-v/index.js";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname } from "path";

type ProviderCommand = { readonly args?: readonly string[]; readonly input?: string };

type OperationRequest = {
    readonly schemaVersion: 1;
    readonly operation: string;
    readonly names?: readonly string[];
    readonly selector?: { readonly kind?: string; readonly name?: string; readonly id?: string };
    readonly name?: string;
    readonly notes?: string;
    readonly identity?: { readonly id?: string; readonly instanceId?: string; readonly name?: string };
    readonly interfaceIndex?: number;
    readonly address?: string;
    readonly prefixLength?: number;
    readonly internalAddressPrefix?: string;
    readonly generation?: number;
    readonly vhdPath?: string;
    readonly path?: string;
    readonly switchName?: string;
    readonly checkpointType?: string;
    readonly newName?: string;
    readonly adapter?: { readonly kind?: string; readonly name?: string };
    readonly staticMacAddress?: string;
    readonly managementSwitchName?: string;
    readonly secureBoot?: { readonly enabled?: boolean; readonly template?: string };
    readonly firstBootDiskPath?: string;
    readonly startupOrder?: readonly string[];
};

type NativeItem = Record<string, unknown>;

export type TypedHyperVNetworkSimulationOptions = {
    readonly stateFile?: string;
    readonly natInstanceIdOverride?: string;
    readonly beforeOperation?: (request: OperationRequest) => Record<string, unknown> | null;
    readonly onOperation?: (request: OperationRequest) => void;
    readonly simulateVmCreate?: boolean | "until-readback";
};

const configuredRunners = new WeakMap<object, TypedHyperVNetworkSimulationOptions>();

export function configureTypedHyperVNetworkOperations<Runner extends object>(
    runner: Runner,
    options: TypedHyperVNetworkSimulationOptions,
): Runner {
    configuredRunners.set(runner, options);
    return runner;
}

function requestOf(command: ProviderCommand): OperationRequest | null {
    if (command.args?.at(-1) !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP || !command.input) return null;
    const envelope = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { input?: unknown };
    if (typeof envelope.input !== "string") return null;
    return JSON.parse(envelope.input) as OperationRequest;
}

function success(operation: string, items: readonly NativeItem[] = []) {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
        stderr: "",
    };
}

export function createTypedHyperVNetworkOperationSimulator(options: TypedHyperVNetworkSimulationOptions = {}) {
    const switches: NativeItem[] = [];
    // Every Hyper-V host with the Default Switch carries an address on its own side of it, so
    // a simulator that omitted one would be modelling a host that cannot exist -- and the
    // bootstrap path, which judges a guest address by whether the host shares its subnet,
    // would have nothing to judge against.
    const addresses: NativeItem[] = [{
        interfaceIndex: 20,
        address: "172.20.0.1",
        prefixLength: 16,
        prefixOrigin: "Manual",
        suffixOrigin: "Manual",
        addressState: "Preferred",
        interfaceAlias: "vEthernet (Default Switch)",
    }];
    const nats: NativeItem[] = [];
    const mountedImages = new Set<string>();
    const virtualMachines: NativeItem[] = [];
    const createdVmId = "12345678-1234-1234-1234-123456789abc";
    let createdVm: NativeItem | null = null;
    let simulateVmCreate = Boolean(options.simulateVmCreate);
    let createdDiskPath = "";
    let virtualSizeBytes = 64 * 1024 * 1024 * 1024;
    let firstBootDiskPath = "";
    let secureBoot: NativeItem = { enabled: false };
    let biosStartupOrder: readonly string[] = ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"];
    const vmAdapters: NativeItem[] = [];
    const managedSwitchId = () => {
        if (options.stateFile && existsSync(options.stateFile)) {
            const state = JSON.parse(readFileSync(options.stateFile, "utf8")) as { switchId?: string };
            if (state.switchId) return state.switchId;
        }
        return switches.find((item) => item.name === "CCC Device Lab")?.id ?? null;
    };
    const adapter = (name: string, switchName: string, macAddress: string | null): NativeItem => ({
        vmId: createdVmId, vmName: createdVm?.name, name,
        switchId: switchName === "Default Switch" ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" : managedSwitchId(),
        switchName, status: "Ok", managementOperatingSystem: false, macAddress, ipAddresses: [],
    });
    let nextSwitchId = 1;
    let nextNatId = 1;
    if (options.stateFile && existsSync(options.stateFile)) {
        const state = JSON.parse(readFileSync(options.stateFile, "utf8")) as Record<string, unknown>;
        if (typeof state.switchId === "string" && typeof state.switchName === "string") {
            switches.push({
                id: state.switchId,
                name: state.switchName,
                switchType: "Internal",
                notes: typeof state.marker === "string" ? state.marker : "ccc-device-lab:hyper-v-network:v1",
            });
            addresses.push({
                interfaceIndex: 42,
                address: typeof state.gateway === "string" ? state.gateway : "172.29.0.1",
                prefixLength: 24,
                prefixOrigin: "Manual",
                suffixOrigin: "Manual",
                addressState: "Preferred",
                interfaceAlias: `vEthernet (${state.switchName})`,
            });
        }
        if (typeof state.natInstanceId === "string" && typeof state.natName === "string") {
            nats.push({
                instanceId: options.natInstanceIdOverride ?? state.natInstanceId,
                name: state.natName,
                internalAddressPrefix: typeof state.prefix === "string" ? state.prefix : "172.29.0.0/24",
            });
        }
        if (Array.isArray(state.allocations)) {
            for (const candidate of state.allocations) {
                if (!candidate || typeof candidate !== "object") continue;
                const allocation = candidate as Record<string, unknown>;
                if (typeof allocation.ownerId !== "string" || typeof allocation.deviceId !== "string"
                    || typeof allocation.incarnationId !== "string") continue;
                virtualMachines.push({
                    id: "12345678-1234-1234-1234-123456789abc",
                    name: `ccc-${allocation.ownerId}-${allocation.deviceId}-${allocation.incarnationId}`,
                    notes: `ccc-device-lab:${allocation.ownerId}:${allocation.deviceId}:${allocation.incarnationId}`,
                });
            }
        }
    }

    return (command: ProviderCommand) => {
        const encodedIndex = command.args?.indexOf("-EncodedCommand") ?? -1;
        const script = encodedIndex >= 0
            ? Buffer.from(command.args?.[encodedIndex + 1] ?? "", "base64").toString("utf16le")
            : "";
        if (script.includes("Storage\\Get-DiskImage -ImagePath $VhdPath")) {
            const path = script.match(/\$VhdPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") ?? "";
            return {
                status: 0,
                stdout: JSON.stringify({ ok: true, path, attached: mountedImages.has(path), partitionStyle: script.includes("$ReadPartitionStyle = $true") ? "GPT" : null }),
                stderr: "",
            };
        }
        const request = requestOf(command);
        if (!request) return null;
        options.onOperation?.(request);
        const intercepted = options.beforeOperation?.(request);
        if (intercepted) return intercepted;
        if (request.operation === "Mount-VHD" && request.path) {
            mountedImages.add(request.path);
            return success(request.operation);
        }
        if (request.operation === "Dismount-VHD" && request.path) {
            mountedImages.delete(request.path);
            return success(request.operation);
        }
        if (request.operation === "Get-VHD" && request.path) {
            if (!existsSync(request.path)) return {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VHD", ok: false, errorCode: "vhd-not-found" }),
                stderr: "",
            };
            const manifestPath = `${dirname(request.path)}/manifest.json`;
            if (existsSync(manifestPath)) {
                const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { virtualSizeBytes?: number };
                if (typeof manifest.virtualSizeBytes === "number") virtualSizeBytes = manifest.virtualSizeBytes;
            }
            return success(request.operation, [{
                path: request.path, vhdFormat: "VHDX", vhdType: "Dynamic", parentPath: null,
                virtualSizeBytes, fileSizeBytes: statSync(request.path).size,
            }]);
        }
        if (options.simulateVmCreate === "until-readback" && request.operation === "New-VM") {
            simulateVmCreate = true;
            createdVm = null;
            vmAdapters.length = 0;
        }
        if (simulateVmCreate) {
            switch (request.operation) {
                case "Get-VM":
                    if (request.selector) return success(request.operation, createdVm && (request.selector.id === createdVmId || request.selector.name === createdVm.name) ? [createdVm] : []);
                    break;
                case "New-VM":
                    vmAdapters.length = 0;
                    createdDiskPath = request.vhdPath ?? "";
                    firstBootDiskPath = createdDiskPath;
                    createdVm = { id: createdVmId, name: request.name, state: "Off", status: "Operating normally", notes: "", uptimeMilliseconds: 0, generation: request.generation, checkpointType: "Disabled" };
                    if (request.switchName) vmAdapters.push(adapter("Network Adapter", request.switchName, null));
                    return success(request.operation, [createdVm]);
                case "Set-VM":
                    if (createdVm) { createdVm.notes = request.notes ?? createdVm.notes; createdVm.checkpointType = request.checkpointType ?? createdVm.checkpointType; }
                    return success(request.operation);
                case "Set-VMMemory": case "Set-VMProcessor": return success(request.operation);
                case "Set-VMBios": biosStartupOrder = request.startupOrder ?? biosStartupOrder; return success(request.operation);
                case "Get-VMBios": return success(request.operation, [{ vmId: createdVmId, startupOrder: biosStartupOrder }]);
                case "Set-VMFirmware":
                    secureBoot = request.secureBoot ?? secureBoot;
                    firstBootDiskPath = request.firstBootDiskPath ?? firstBootDiskPath;
                    return success(request.operation);
                case "Get-VMFirmware": return success(request.operation, [{
                    vmId: createdVmId, secureBoot: secureBoot.enabled ? "On" : "Off",
                    secureBootTemplate: secureBoot.template ?? "", firstBootDevicePath: firstBootDiskPath,
                }]);
                case "Get-VMHardDiskDrive": return success(request.operation, createdVm ? [{
                    vmId: createdVmId, vmName: createdVm.name, path: createdDiskPath,
                    controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0, diskNumber: null,
                }] : []);
                case "Get-VMDvdDrive": return success(request.operation, []);
                case "Rename-VMNetworkAdapter": {
                    const found = request.adapter?.kind === "sole" && vmAdapters.length === 1
                        ? vmAdapters[0] : vmAdapters.find((item) => item.name === request.adapter?.name);
                    if (found) found.name = request.newName;
                    return success(request.operation);
                }
                case "Add-VMNetworkAdapter":
                    vmAdapters.push(adapter(request.name ?? "", request.switchName ?? "", null));
                    return success(request.operation);
                case "Set-VMNetworkAdapter": {
                    const found = request.adapter?.kind === "sole" && vmAdapters.length === 1
                        ? vmAdapters[0] : vmAdapters.find((item) => item.name === request.adapter?.name);
                    if (found) found.macAddress = request.staticMacAddress;
                    return success(request.operation);
                }
                case "Get-VMNetworkAdapter":
                    if (!request.managementSwitchName) {
                        const result = success(request.operation, createdVm ? vmAdapters : []);
                        if (options.simulateVmCreate === "until-readback" && createdVm
                            && ((vmAdapters.length === 1 && Boolean(request.selector))
                                || (vmAdapters.length === 2 && !request.selector))) simulateVmCreate = false;
                        return result;
                    }
                    break;
                case "Remove-VM": createdVm = null; vmAdapters.length = 0; return success(request.operation);
            }
        }
        switch (request.operation) {
            case "Get-VMSwitch": return success(request.operation,
                request.selector?.name === "Default Switch"
                    ? [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Default Switch", switchType: "Internal", notes: "" }]
                    : switches);
            case "New-VMSwitch": {
                const item = {
                    id: `00000000-0000-0000-0000-${String(nextSwitchId++).padStart(12, "0")}`,
                    name: request.name,
                    switchType: "Internal",
                    notes: request.notes,
                };
                switches.push(item);
                return success(request.operation, [item]);
            }
            case "Set-VMSwitch": {
                const found = switches.find((item) => item.id === request.identity?.id);
                if (found) found.notes = request.notes;
                return success(request.operation);
            }
            case "Remove-VMSwitch": {
                const index = switches.findIndex((item) => item.id === request.identity?.id);
                if (index >= 0) switches.splice(index, 1);
                return success(request.operation);
            }
            // This simulator models the host network fabric, not any VM. A VM-scoped or
            // management-scoped adapter read asks about something it does not know, so it
            // defers to the caller's own host rather than answering "none" -- an empty answer
            // here is a claim, and a wrong one, that would hide whatever the caller models.
            case "Get-VMNetworkAdapter":
                return request.selector || request.managementSwitchName ? null : success(request.operation);
            case "Get-VM": return request.names ? success(
                request.operation,
                virtualMachines.filter((item) => request.names?.includes(String(item.name))),
            ) : null;
            case "Get-NetAdapter": return success(request.operation, switches.length === 0 ? [] : [{
                interfaceIndex: 42,
                name: `vEthernet (${String(switches[0]?.name)})`,
                status: "Up",
                interfaceDescription: "Hyper-V Virtual Ethernet Adapter",
            }]);
            case "Get-NetIPAddress": return success(request.operation, addresses);
            case "New-NetIPAddress": {
                const item = {
                    interfaceIndex: request.interfaceIndex,
                    address: request.address,
                    prefixLength: request.prefixLength,
                    prefixOrigin: "Manual",
                    suffixOrigin: "Manual",
                    addressState: "Preferred",
                    interfaceAlias: `vEthernet (${String(switches[0]?.name ?? "")})`,
                };
                addresses.push(item);
                return success(request.operation, [item]);
            }
            case "Remove-NetIPAddress": {
                const index = addresses.findIndex((item) => item.interfaceIndex === request.interfaceIndex
                    && item.address === request.address && item.prefixLength === request.prefixLength);
                if (index >= 0) addresses.splice(index, 1);
                return success(request.operation);
            }
            case "Get-NetNat": return success(request.operation, nats);
            case "New-NetNat": {
                const item = {
                    instanceId: `ccc-test-nat-${nextNatId++}`,
                    name: request.name,
                    internalAddressPrefix: request.internalAddressPrefix,
                };
                nats.push(item);
                return success(request.operation, [item]);
            }
            case "Remove-NetNat": {
                const index = nats.findIndex((item) => item.instanceId === request.identity?.instanceId);
                if (index >= 0) nats.splice(index, 1);
                return success(request.operation);
            }
            default: return null;
        }
    };
}

export function withTypedHyperVNetworkOperations<Command extends ProviderCommand, Options, Result>(
    runner: (command: Command, options: Options) => Result,
    options: TypedHyperVNetworkSimulationOptions = {},
): (command: Command, options: Options) => Result {
    const simulate = createTypedHyperVNetworkOperationSimulator({
        ...options,
        ...(configuredRunners.get(runner) ?? {}),
    });
    return (command, options) => (simulate(command) as Result | null) ?? runner(command, options);
}
