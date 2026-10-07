import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeviceLabBinaryFile } from "@ccc/device-lab/device-lab-state-file.js";
import { assertStateDirectoriesUnchanged, secureStateParentDirectory, withSharedMutationLock, writeFileAtomically } from "@ccc/device-lab/device-lab-shared-state.js";
import { probeDeviceRuntimeProcessLiveness } from "@ccc/device-lab/device-lab-process-identity.js";
import { decodeHyperVNetworkState } from "@ccc/device-lab/device-lab/broker/hyper-v/network-state.js";
import { resolveTrustedWindowsSystemExecutables } from "./real-tests/hyper-v-windows-library-real.ts";

const FIXTURE_SWITCH = "00000000-0000-0000-0000-000000000001";
const FIXTURE_NAT = "ccc-test-nat-1";
const FIXTURE_OWNER = "d1b76dee591d4a9d";
const FIXTURE_SANDBOX = "12345678-1234-4234-9234-1234567890ab";
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const BACKUP_SUFFIX = ".test-fixture-backup.json";

class RepairRefused extends Error {}
function refuse(code: string): never { throw new RepairRefused(`test-state-repair-${code}`); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse("observation-invalid");
    return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse("observation-invalid");
}
function text(value: unknown): value is string {
    return typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function rows(value: unknown, fields: Record<string, "text" | "integer">): Record<string, unknown>[] {
    if (!Array.isArray(value) || value.length > 4096) refuse("observation-invalid");
    return value.map(item => {
        const row = record(item);
        exactKeys(row, Object.keys(fields));
        for (const [key, kind] of Object.entries(fields)) {
            if (kind === "text" ? !text(row[key]) : !Number.isSafeInteger(row[key]) || Number(row[key]) < 0) refuse("observation-invalid");
        }
        return row;
    });
}
function one<T>(values: T[], code: string): T {
    if (values.length !== 1) refuse(code);
    return values[0]!;
}
function mac(value: unknown): string {
    const result = String(value).replace(/[:-]/g, "").toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(result) || result === "000000000000") refuse("adapter-invalid");
    return result;
}

/** Injectable read-only boundary; every returned field is validated before use. */
export type RepairObservers = {
    network(): unknown;
    sandbox(pid: number): unknown;
};

function networkIdentity(raw: unknown, state: Record<string, unknown>) {
    const observation = record(raw);
    exactKeys(observation, ["switches", "nats", "managementAdapters", "adapters", "addresses"]);
    const switches = rows(observation.switches, { id: "text", name: "text", type: "text", marker: "text" });
    const nats = rows(observation.nats, { name: "text", instanceId: "text", prefix: "text" });
    const management = rows(observation.managementAdapters, { switchId: "text", switchName: "text", macAddress: "text" });
    const adapters = rows(observation.adapters, { index: "integer", macAddress: "text", status: "text" });
    const addresses = rows(observation.addresses, { index: "integer", address: "text", prefixLength: "integer", state: "text" });
    const sw = one(switches.filter(item => item.name === state.switchName || item.marker === state.marker), "switch-ambiguous");
    if (sw.name !== state.switchName || sw.marker !== state.marker || sw.type !== "Internal"
        || !GUID.test(String(sw.id)) || sw.id === FIXTURE_SWITCH
        || switches.filter(item => item.id === sw.id).length !== 1) refuse("switch-mismatch");
    const nat = one(nats.filter(item => item.name === state.natName || item.prefix === state.prefix), "nat-ambiguous");
    if (nat.name !== state.natName || nat.prefix !== state.prefix || !nat.instanceId || nat.instanceId === FIXTURE_NAT
        || nats.filter(item => item.instanceId === nat.instanceId).length !== 1) refuse("nat-mismatch");
    const host = one(management.filter(item => String(item.switchId).toLowerCase() === String(sw.id).toLowerCase()), "adapter-ambiguous");
    if (host.switchName !== sw.name) refuse("adapter-mismatch");
    const hostMac = mac(host.macAddress);
    const adapter = one(adapters.filter(item => String(item.macAddress).replace(/[:-]/g, "").toUpperCase() === hostMac), "adapter-ambiguous");
    if (adapter.index === 0 || adapter.status !== "Up"
        || adapters.filter(item => item.index === adapter.index).length !== 1) refuse("adapter-mismatch");
    const gateway = one(addresses.filter(item => item.address === state.gateway), "gateway-ambiguous");
    if (gateway.index !== adapter.index || gateway.prefixLength !== 24 || gateway.state !== "Preferred") refuse("gateway-mismatch");
    return { switchId: String(sw.id).toLowerCase(), natInstanceId: String(nat.instanceId), interfaceIndex: adapter.index, hostMac };
}

function safeRead(file: string): Buffer | null {
    const directories = secureStateParentDirectory(file, { create: false });
    const value = readDeviceLabBinaryFile(file, "test-state-repair", 256 * 1024);
    assertStateDirectoriesUnchanged(directories);
    return value;
}
function parsed(bytes: Buffer): Record<string, unknown> {
    try { return record(JSON.parse(bytes.toString("utf8"))); } catch { return refuse("state-invalid"); }
}
function unchanged(file: string, original: Buffer | null): void {
    const current = safeRead(file);
    if (original === null ? current !== null : current === null || !current.equals(original)) refuse("state-changed");
}
function absent(file: string): void {
    const directories = secureStateParentDirectory(file, { create: false });
    try { lstatSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            assertStateDirectoriesUnchanged(directories);
            return;
        }
        refuse("absence-unverified");
    }
    refuse("owner-state-present");
}
function backup(file: string, bytes: Buffer): string {
    const destination = file + BACKUP_SUFFIX;
    const directories = secureStateParentDirectory(destination, { create: false });
    const existing = safeRead(destination);
    if (existing) {
        if (!existing.equals(bytes)) refuse("backup-conflict");
        return destination;
    }
    const descriptor = openSync(destination, "wx", 0o600);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    assertStateDirectoriesUnchanged(directories);
    unchanged(destination, bytes);
    return destination;
}

function sandboxFixture(bytes: Buffer, hostName: string): number {
    const lock = parsed(bytes);
    exactKeys(lock, ["provider", "host", "bootId", "ownerId", "deviceId", "sandboxId", "claimId", "pid", "acquiredAt", "updatedAt"]);
    if (lock.provider !== "windows-sandbox" || lock.host !== hostName || lock.ownerId !== FIXTURE_OWNER
        || lock.deviceId !== "windows-refresh" || lock.sandboxId !== FIXTURE_SANDBOX
        || typeof lock.claimId !== "string" || !/^[a-f0-9]{32}$/.test(lock.claimId)
        || typeof lock.bootId !== "string" || !lock.bootId.startsWith(`${hostName}:`)
        || !/^\d{1,12}$/.test(lock.bootId.slice(hostName.length + 1))
        || !Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 || Number(lock.pid) > 2147483647
        || typeof lock.acquiredAt !== "string" || !Number.isFinite(Date.parse(lock.acquiredAt))
        || lock.updatedAt !== lock.acquiredAt) refuse("sandbox-not-known-fixture");
    return Number(lock.pid);
}
function sandboxAbsent(raw: unknown): void {
    const observation = record(raw);
    exactKeys(observation, ["runtime", "pidStatus"]);
    const runtime = record(observation.runtime);
    exactKeys(runtime, ["WindowsSandboxEnvironments"]);
    if (!Array.isArray(runtime.WindowsSandboxEnvironments) || runtime.WindowsSandboxEnvironments.length !== 0) refuse("sandbox-runtime-not-empty");
    if (observation.pidStatus !== "exited") refuse("sandbox-process-not-exited");
}

export function repairDeviceLabTestState(options: {
    homeDir: string;
    observers: RepairObservers;
    hostName?: string;
    lockWaitMs?: number;
}) {
    const root = join(options.homeDir, ".ccc");
    const networkFile = join(root, "device-broker-private", "network", "hyper-v.json");
    const intentFile = join(root, "device-broker-private", "network", "hyper-v-intent.json");
    const sandboxFile = join(root, "devices", "host-locks", "windows-sandbox.json");
    const ownerRoot = join(root, "devices", "owners", FIXTURE_OWNER, "windows");
    const lockRoot = join(root, "devices", "host-locks");
    return withSharedMutationLock(join(lockRoot, "hyper-v.mutation.lock"), () =>
        withSharedMutationLock(join(lockRoot, "windows-sandbox.mutation.lock"), () => {
            const networkBytes = safeRead(networkFile);
            const sandboxBytes = safeRead(sandboxFile);
            if (safeRead(intentFile) !== null) refuse("network-intent-pending");
            let network: Record<string, unknown> | null = null;
            let identity: ReturnType<typeof networkIdentity> | null = null;
            if (networkBytes) {
                const value = parsed(networkBytes);
                try { decodeHyperVNetworkState(value); } catch { refuse("network-state-invalid"); }
                if (value.switchId === FIXTURE_SWITCH || value.natInstanceId === FIXTURE_NAT) {
                    if (value.switchId !== FIXTURE_SWITCH || value.natInstanceId !== FIXTURE_NAT
                        || typeof value.marker !== "string" || !/^ccc-device-lab:hyper-v-network:[a-f0-9]{24}$/.test(value.marker)) refuse("network-not-known-fixture");
                    network = value;
                    identity = networkIdentity(options.observers.network(), value);
                }
            }
            const pid = sandboxBytes ? sandboxFixture(sandboxBytes, options.hostName ?? hostname()) : null;
            if (pid !== null) {
                absent(ownerRoot);
                sandboxAbsent(options.observers.sandbox(pid));
            }
            // Reobserve under both provider locks before changing either state file.
            if (network && identity && JSON.stringify(networkIdentity(options.observers.network(), network)) !== JSON.stringify(identity)) refuse("network-observation-changed");
            if (pid !== null) { absent(ownerRoot); sandboxAbsent(options.observers.sandbox(pid)); }
            unchanged(networkFile, networkBytes);
            unchanged(sandboxFile, sandboxBytes);
            unchanged(intentFile, null);
            const backups: string[] = [];
            if (network && networkBytes) backups.push(backup(networkFile, networkBytes));
            if (sandboxBytes) backups.push(backup(sandboxFile, sandboxBytes));
            // Backup publication can fail; no provider state has changed at this point.
            unchanged(networkFile, networkBytes);
            unchanged(sandboxFile, sandboxBytes);
            unchanged(intentFile, null);
            if (pid !== null) absent(ownerRoot);
            const result = { network: "unchanged", sandbox: "unchanged", backups };
            try {
                if (network && identity) {
                    const repaired = { ...network, switchId: identity.switchId, natInstanceId: identity.natInstanceId,
                        managedSwitch: false, managedGateway: false, managedNat: false };
                    // Validate but serialize the original object, retaining every allocation field.
                    decodeHyperVNetworkState(repaired);
                    result.network = "repair-attempted";
                    writeFileAtomically(networkFile, JSON.stringify(repaired, null, 2) + "\n");
                    result.network = "repaired";
                }
                if (sandboxBytes) {
                    unchanged(sandboxFile, sandboxBytes);
                    result.sandbox = "quarantine-attempted";
                    unlinkSync(sandboxFile);
                    result.sandbox = "quarantined";
                }
            } catch (error) {
                // A filesystem failure during the commit must report any completed change.
                throw Object.assign(new RepairRefused("test-state-repair-commit-failed"), { result, cause: error });
            }
            return result;
        }, { waitMs: options.lockWaitMs ?? 5000 }), { waitMs: options.lockWaitMs ?? 5000, staleMs: 30 * 60 * 1000 });
}

// Fixed read-only program: no provider lifecycle or network mutation commands.
export const NETWORK_OBSERVATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = @{
 switches = @(Hyper-V\Get-VMSwitch -ErrorAction Stop | ForEach-Object { @{ id=[string]$_.Id; name=[string]$_.Name; type=[string]$_.SwitchType; marker=[string]$_.Notes } })
 nats = @(NetNat\Get-NetNat -ErrorAction Stop | ForEach-Object { @{ name=[string]$_.Name; instanceId=[string]$_.InstanceID; prefix=[string]$_.InternalIPInterfaceAddressPrefix } })
 managementAdapters = @(Hyper-V\Get-VMNetworkAdapter -ManagementOS -ErrorAction Stop | ForEach-Object { @{ switchId=[string]$_.SwitchId; switchName=[string]$_.SwitchName; macAddress=[string]$_.MacAddress } })
 adapters = @(NetAdapter\Get-NetAdapter -IncludeHidden -ErrorAction Stop | ForEach-Object { @{ index=[int]$_.ifIndex; macAddress=[string]$_.MacAddress; status=[string]$_.Status } })
 addresses = @(NetTCPIP\Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { @{ index=[int]$_.InterfaceIndex; address=[string]$_.IPAddress; prefixLength=[int]$_.PrefixLength; state=[string]$_.AddressState } })
}
$result | ConvertTo-Json -Depth 5 -Compress
`;

function nativeJson(provider: "network" | "sandbox", command: string, args: string[]): unknown {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true });
    if (result.status !== 0 || result.error || result.signal) refuse(`${provider}-native-observation-unavailable`);
    try { return JSON.parse(result.stdout.trim()); } catch { return refuse(`${provider}-native-observation-invalid`); }
}

export function runRepairDeviceLabTestStateCli(args = process.argv.slice(2)): number {
    if (args.length === 1 && args[0] === "--help") {
        process.stdout.write("Usage: node --import tsx scripts/repair-device-lab-test-state.ts\nRepairs only verified historical test metadata on Windows, preserving original backups and all provider resources.\n");
        return 0;
    }
    if (args.length !== 0) {
        process.stderr.write("test-state-repair-unknown-argument; use --help\n");
        return 1;
    }
    if (process.platform !== "win32") {
        process.stderr.write("test-state-repair-windows-host-required\n");
        return 1;
    }
    try {
        const powershell = resolveTrustedWindowsSystemExecutables().powershell;
        const result = repairDeviceLabTestState({ homeDir: homedir(), observers: {
            network: () => nativeJson("network", powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(NETWORK_OBSERVATION_SCRIPT, "utf16le").toString("base64")]),
            sandbox: pid => ({ runtime: nativeJson("sandbox", "wsb.exe", ["list", "--raw"]), pidStatus: probeDeviceRuntimeProcessLiveness(pid) }),
        } });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return 0;
    } catch (error) {
        if (error instanceof RepairRefused && "result" in error) process.stdout.write(JSON.stringify(error.result, null, 2) + "\n");
        process.stderr.write((error instanceof RepairRefused ? error.message : "test-state-repair-state-access-failed") + "\n");
        return 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runRepairDeviceLabTestStateCli();
