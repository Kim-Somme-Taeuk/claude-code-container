import { isIP } from "net";

import {
    createHyperVGuestDirectClient,
    HyperVWindowsError,
    type HyperVGuestDirectIdentity,
} from "../../../hyper-v-windows/index.js";
import {
    createDeviceLabHyperVWindowsClient,
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

const PROBE_SOURCE = [
    "$Winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'",
    "[ordered]@{",
    "  computerName = [Environment]::MachineName",
    "  addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress)",
    "  firstLogonCompleted = [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\ccc' -Name 'FirstLogonCompleted' -ErrorAction SilentlyContinue).FirstLogonCompleted",
    "  provisioningSecretsPresent = [bool]((Test-Path -LiteralPath 'C:\\Windows\\Panther\\unattend.xml') -or (Test-Path -LiteralPath 'C:\\Windows\\Panther\\Unattend\\unattend.xml') -or ($null -ne (Get-ItemProperty -LiteralPath $Winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue)))",
    "} | ConvertTo-Json -Compress -Depth 4",
].join("\n");

type GuestProbe = {
    readonly computerName: string;
    readonly addresses: readonly string[];
    readonly firstLogonCompleted: string;
    readonly provisioningSecretsPresent: boolean;
};

export type DeviceLabHyperVGuestReadinessOutcome =
    | { readonly ok: true; readonly vmId: string; readonly vmName: string; readonly computerName: string; readonly attempts: number; readonly networkAddress: string }
    | { readonly ok: false; readonly error: "hyper-v-guest-ready-timeout" | "hyper-v-guest-ready-failed"; readonly reason: string; readonly attempts: number; readonly scrubConfirmed: boolean; readonly mediaDetached: boolean };

type Options = Omit<DeviceLabHyperVWindowsClientOptions, "session" | "record"> & {
    readonly identity: HyperVGuestDirectIdentity;
    readonly provisioningMediaPath: string;
    readonly expectedNetworkAddress: string;
    readonly timeoutMilliseconds: number;
    readonly noProgressTimeoutMilliseconds?: number;
    readonly removeProvisioningMedia: () => void | Promise<void>;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
};

class ReadinessRetry extends Error {
    constructor(readonly reason: string) { super(reason); }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseProbe(value: string): GuestProbe | null {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return null; }
    const item = record(parsed);
    if (!item || Object.keys(item).sort().join("|") !== [
        "addresses", "computerName", "firstLogonCompleted", "provisioningSecretsPresent",
    ].join("|")) return null;
    if (typeof item.computerName !== "string" || item.computerName.length < 1 || item.computerName.length > 255
        || typeof item.firstLogonCompleted !== "string" || item.firstLogonCompleted.length > 4096
        || typeof item.provisioningSecretsPresent !== "boolean" || !Array.isArray(item.addresses)
        || item.addresses.length > 64 || !item.addresses.every((address) => typeof address === "string" && isIP(address) === 4)) return null;
    return item as GuestProbe;
}

function probeFingerprint(probe: GuestProbe): string {
    return JSON.stringify([
        probe.firstLogonCompleted,
        probe.provisioningSecretsPresent,
        [...new Set(probe.addresses)].sort(),
    ]);
}

function boundedReason(error: unknown): string {
    if (error instanceof HyperVWindowsError) {
        const directCodes: Record<string, string> = {
            "powershell-direct-attempt-timeout": "powershell-direct-attempt-timeout",
            "powershell-direct-authentication-failed": "powershell-direct-authentication-failed",
            "powershell-direct-session-unavailable": "powershell-direct-session-unavailable",
            "powershell-direct-unavailable": "powershell-direct-unavailable",
            "guest-vm-identity-mismatch": "hyper-v-vm-ownership-mismatch",
            "dvd-vm-identity-mismatch": "hyper-v-vm-ownership-mismatch",
            "guest-requires-running-vm": "hyper-v-guest-vm-not-running",
            "guest-credential-unavailable": "hyper-v-guest-credential-unavailable",
            "guest-credential-invalid": "hyper-v-guest-credential-invalid",
            "dvd-attachment-ambiguous": "hyper-v-guest-provisioning-media-attachment-ambiguous",
            "dvd-still-attached": "hyper-v-guest-provisioning-media-detach-failed",
        };
        if (directCodes[error.code]) return directCodes[error.code];
        if (/AccessDenied|InvalidCredential|Authentication/i.test(error.code)) return "powershell-direct-authentication-failed";
        if (/PSSession|VMNotRunning|InvalidState/i.test(error.code)) return "powershell-direct-session-unavailable";
        if (error.category === "transport" && error.code === "timeout") return "powershell-direct-timeout";
    }
    return "powershell-direct-unavailable";
}

async function inspectDetached(
    client: ReturnType<typeof createDeviceLabHyperVWindowsClient>,
    identity: HyperVGuestDirectIdentity,
    path: string,
    deadline: number,
    now: () => number,
): Promise<boolean> {
    try {
        if (now() >= deadline) return false;
        const machines = await client.getVM(identity.selector);
        if (machines.length !== 1 || machines[0].name !== identity.expectedName
            || machines[0].notes !== identity.expectedNotes) return false;
        if (now() >= deadline) return false;
        const drives = await client.getVMDvdDrives(identity.selector);
        return drives.every((drive) => drive.path?.toLowerCase() !== path.toLowerCase());
    } catch { return false; }
}

export async function waitForDeviceLabHyperVGuestReadiness(options: Options): Promise<DeviceLabHyperVGuestReadinessOutcome> {
    if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1000
        || options.timeoutMilliseconds > 20 * 60 * 1000
        || (options.noProgressTimeoutMilliseconds !== undefined
            && (!Number.isSafeInteger(options.noProgressTimeoutMilliseconds)
                || options.noProgressTimeoutMilliseconds < 1000
                || options.noProgressTimeoutMilliseconds > options.timeoutMilliseconds))) {
        return { ok: false, error: "hyper-v-guest-ready-failed", reason: "hyper-v-guest-ready-precondition-failed", attempts: 0, scrubConfirmed: false, mediaDetached: false };
    }
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = now() + options.timeoutMilliseconds;
    let stableObservationFingerprint: string | null = null;
    let stableObservationDeadline: number | null = null;
    const remainingTimeout = () => {
        const observedAt = now();
        return Math.max(1, Math.min(
            15000,
            deadline - observedAt,
            stableObservationDeadline === null ? Number.POSITIVE_INFINITY : stableObservationDeadline - observedAt,
        ));
    };
    const transport = {
        executable: options.executable,
        timeoutMilliseconds: remainingTimeout,
        run: options.run,
    };
    const guest = createHyperVGuestDirectClient(createDeviceLabHyperVWindowsExecutor(transport));
    const host = createDeviceLabHyperVWindowsClient(transport);
    let attempts = 0;
    let reason = "powershell-direct-unavailable";
    let scrubConfirmed = false;
    let mediaDetached = false;
    while (true) {
        const attemptStartedAt = now();
        if (attemptStartedAt >= deadline
            || (stableObservationDeadline !== null && attemptStartedAt >= stableObservationDeadline)) break;
        attempts += 1;
        let currentObservationFingerprint: string | null = null;
        try {
            const output = await guest.invoke({ ...options.identity, action: "job", command: PROBE_SOURCE }, remainingTimeout());
            if (output.action !== "job") throw new Error("guest-probe-result-invalid");
            const probe = parseProbe(output.output);
            if (!probe) throw new ReadinessRetry("hyper-v-guest-probe-invalid");
            currentObservationFingerprint = `probe:${probeFingerprint(probe)}`;
            if (options.noProgressTimeoutMilliseconds !== undefined
                && currentObservationFingerprint !== stableObservationFingerprint) {
                stableObservationFingerprint = currentObservationFingerprint;
                stableObservationDeadline = now() + options.noProgressTimeoutMilliseconds;
            }
            if (probe.firstLogonCompleted !== options.identity.expectedNotes) {
                throw new ReadinessRetry("hyper-v-guest-first-logon-incomplete");
            }
            if (probe.provisioningSecretsPresent) {
                throw new ReadinessRetry("hyper-v-guest-provisioning-not-scrubbed");
            }
            scrubConfirmed = true;
            if (now() >= deadline) throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            if (!mediaDetached) {
                try {
                    await host.removeVMDvdDrive({
                        selector: options.identity.selector,
                        expectedName: options.identity.expectedName,
                        expectedNotes: options.identity.expectedNotes,
                        path: options.provisioningMediaPath,
                    });
                    mediaDetached = true;
                } catch (error) {
                    mediaDetached = await inspectDetached(host, options.identity, options.provisioningMediaPath, deadline, now);
                    if (!mediaDetached) {
                        return {
                            ok: false, error: "hyper-v-guest-ready-failed", reason: boundedReason(error),
                            attempts, scrubConfirmed, mediaDetached,
                        };
                    }
                }
            }
            if (now() >= deadline) throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            try {
                await options.removeProvisioningMedia();
            } catch {
                throw new ReadinessRetry("hyper-v-guest-provisioning-media-delete-failed");
            }
            if (now() >= deadline) throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            if (options.expectedNetworkAddress && !probe.addresses.includes(options.expectedNetworkAddress)) {
                throw new ReadinessRetry("hyper-v-guest-network-not-ready");
            }
            return {
                ok: true, vmId: options.identity.selector.id.toLowerCase(), vmName: options.identity.expectedName,
                computerName: probe.computerName, attempts, networkAddress: options.expectedNetworkAddress,
            };
        } catch (error) {
            reason = error instanceof ReadinessRetry ? error.reason : boundedReason(error);
            if (error instanceof HyperVWindowsError) currentObservationFingerprint = `transport:${reason}`;
        }
        const observedAt = now();
        let noProgressRemaining = Number.POSITIVE_INFINITY;
        if (currentObservationFingerprint !== null && options.noProgressTimeoutMilliseconds !== undefined) {
            if (currentObservationFingerprint !== stableObservationFingerprint) {
                stableObservationFingerprint = currentObservationFingerprint;
                stableObservationDeadline = observedAt + options.noProgressTimeoutMilliseconds;
            }
            noProgressRemaining = (stableObservationDeadline ?? observedAt) - observedAt;
            if (noProgressRemaining <= 0) break;
        } else {
            // Malformed or unclassified output is not a stable bounded observation.
            stableObservationFingerprint = null;
            stableObservationDeadline = null;
        }
        const remaining = deadline - observedAt;
        if (remaining > 0) await sleep(Math.min(2000, remaining, noProgressRemaining));
    }
    return { ok: false, error: "hyper-v-guest-ready-timeout", reason, attempts, scrubConfirmed, mediaDetached };
}
