import type { HyperVWindowsGuestBootDiagnostic } from "./contracts.js";

const VM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_KEYS = "bootDeviceTypes|bootEntries|diagnosticComplete|diagnosticErrors|dvdCount|dvdDrives|generation|hardDiskControllers|hardDiskCount|hardDisks|heartbeatEnabled|heartbeatPrimaryStatus|heartbeatSecondaryStatus|integrationServices|ok|secureBootEnabled|state|uptimeMs|vmId|vmName";
const HOST_TEXT_PATTERN = /[\\/:\u0000-\u001f]/;

export function parseHyperVWindowsGuestBootDiagnostic(value: unknown): HyperVWindowsGuestBootDiagnostic | null {
    const parsed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const diagnosticErrorCodes = new Set([
        "hyper-v-diagnostic-vm-observation-incomplete",
        "hyper-v-diagnostic-integration-services-unavailable",
        "hyper-v-diagnostic-integration-services-incomplete",
        "hyper-v-diagnostic-firmware-unavailable",
        "hyper-v-diagnostic-firmware-incomplete",
        "hyper-v-diagnostic-bios-unavailable",
        "hyper-v-diagnostic-bios-incomplete",
        "hyper-v-diagnostic-hard-disks-unavailable",
        "hyper-v-diagnostic-hard-disks-incomplete",
        "hyper-v-diagnostic-vhd-inspection-incomplete",
        "hyper-v-diagnostic-dvd-drives-unavailable",
    ]);
    if (!parsed
        || Object.keys(parsed).sort().join("|") !== DIAGNOSTIC_KEYS
        || parsed.ok !== true
        || typeof parsed.vmId !== "string"
        || !VM_ID_PATTERN.test(parsed.vmId)
        || typeof parsed.vmName !== "string"
        || parsed.vmName.length < 1 || parsed.vmName.length > 100 || /[\u0000-\u001f]/.test(parsed.vmName)
        || typeof parsed.state !== "string"
        || parsed.state.length > 64
        || !["Unknown", "Off", "Running", "Starting", "Stopping", "Saving", "Saved", "Pausing", "Paused", "Resuming", "Reset", "FastSaved", "FastSaving", "ForceShutdown", "ForceReboot", "RunningCritical", "OffCritical", "StoppingCritical", "SavedCritical", "PausedCritical", "StartingCritical", "ResetCritical", "SavingCritical", "PausingCritical", "ResumingCritical", "FastSavedCritical", "FastSavingCritical"].includes(parsed.state)
        || typeof parsed.uptimeMs !== "number"
        || !Number.isSafeInteger(parsed.uptimeMs)
        || parsed.uptimeMs < 0
        || (parsed.generation !== null && parsed.generation !== 1 && parsed.generation !== 2)
        || (parsed.secureBootEnabled !== null && typeof parsed.secureBootEnabled !== "boolean")
        || (parsed.heartbeatEnabled !== null && typeof parsed.heartbeatEnabled !== "boolean")
        || (parsed.heartbeatPrimaryStatus !== null && (typeof parsed.heartbeatPrimaryStatus !== "number" || !Number.isSafeInteger(parsed.heartbeatPrimaryStatus) || parsed.heartbeatPrimaryStatus < 0))
        || (parsed.heartbeatSecondaryStatus !== null && (typeof parsed.heartbeatSecondaryStatus !== "number" || !Number.isSafeInteger(parsed.heartbeatSecondaryStatus) || parsed.heartbeatSecondaryStatus < 0))
        || !Array.isArray(parsed.integrationServices)
        || parsed.integrationServices.length > 16
        || parsed.integrationServices.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const service = candidate as Record<string, unknown>;
            return Object.keys(service).sort().join("|") !== "enabled|name|primaryStatus|secondaryStatus"
                || typeof service.name !== "string"
                || service.name.length < 1
                || service.name.length > 128
                || HOST_TEXT_PATTERN.test(service.name)
                || typeof service.enabled !== "boolean"
                || (service.primaryStatus !== null && (typeof service.primaryStatus !== "number" || !Number.isSafeInteger(service.primaryStatus) || service.primaryStatus < 0))
                || (service.secondaryStatus !== null && (typeof service.secondaryStatus !== "number" || !Number.isSafeInteger(service.secondaryStatus) || service.secondaryStatus < 0));
        })
        || typeof parsed.hardDiskCount !== "number"
        || !Number.isSafeInteger(parsed.hardDiskCount)
        || parsed.hardDiskCount < 0
        || parsed.hardDiskCount > 4096
        || typeof parsed.dvdCount !== "number"
        || !Number.isSafeInteger(parsed.dvdCount)
        || parsed.dvdCount < 0
        || parsed.dvdCount > 4096
        || !Array.isArray(parsed.hardDiskControllers)
        || parsed.hardDiskControllers.length > 8
        || parsed.hardDiskControllers.some((candidate: unknown) => candidate !== "ide" && candidate !== "scsi")
        || !Array.isArray(parsed.bootDeviceTypes)
        || parsed.bootDeviceTypes.length > 8
        || parsed.bootDeviceTypes.some((candidate: unknown) => !["hard-disk", "dvd", "network", "unknown"].includes(candidate as string))
        || !Array.isArray(parsed.bootEntries)
        || parsed.bootEntries.length > 8
        || parsed.bootEntries.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const entry = candidate as Record<string, unknown>;
            return Object.keys(entry).sort().join("|") !== "bootType|controllerLocation|controllerNumber|controllerType|deviceType"
                || typeof entry.bootType !== "string" || entry.bootType.length > 64 || HOST_TEXT_PATTERN.test(entry.bootType)
                || typeof entry.deviceType !== "string" || entry.deviceType.length > 128 || HOST_TEXT_PATTERN.test(entry.deviceType)
                || typeof entry.controllerType !== "string" || entry.controllerType.length > 32 || HOST_TEXT_PATTERN.test(entry.controllerType)
                || (entry.controllerNumber !== null && (!Number.isSafeInteger(entry.controllerNumber) || Number(entry.controllerNumber) < 0))
                || (entry.controllerLocation !== null && (!Number.isSafeInteger(entry.controllerLocation) || Number(entry.controllerLocation) < 0));
        })
        || !Array.isArray(parsed.hardDisks)
        || parsed.hardDisks.length > 8
        || parsed.hardDisks.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const disk = candidate as Record<string, unknown>;
            const nullableNonNegativeInteger = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
            return Object.keys(disk).sort().join("|") !== "controllerLocation|controllerNumber|controllerType|fileSizeBytes|logicalSectorSize|minimumSizeBytes|physicalSectorSize|sizeBytes|vhdFormat|vhdType"
                || typeof disk.controllerType !== "string" || !["ide", "scsi"].includes(disk.controllerType)
                || !nullableNonNegativeInteger(disk.controllerNumber)
                || !nullableNonNegativeInteger(disk.controllerLocation)
                || typeof disk.vhdFormat !== "string" || disk.vhdFormat.length > 32 || HOST_TEXT_PATTERN.test(disk.vhdFormat)
                || typeof disk.vhdType !== "string" || disk.vhdType.length > 32 || HOST_TEXT_PATTERN.test(disk.vhdType)
                || !nullableNonNegativeInteger(disk.sizeBytes)
                || !nullableNonNegativeInteger(disk.fileSizeBytes)
                || !nullableNonNegativeInteger(disk.minimumSizeBytes)
                || !nullableNonNegativeInteger(disk.logicalSectorSize)
                || !nullableNonNegativeInteger(disk.physicalSectorSize);
        })
        || !Array.isArray(parsed.dvdDrives)
        || parsed.dvdDrives.length > 8
        || parsed.dvdDrives.some((candidate: unknown) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
            const dvd = candidate as Record<string, unknown>;
            return Object.keys(dvd).sort().join("|") !== "controllerLocation|controllerNumber|controllerType|mediaAttached"
                || typeof dvd.controllerType !== "string" || !["ide", "scsi", ""].includes(dvd.controllerType)
                || (dvd.controllerNumber !== null && (!Number.isSafeInteger(dvd.controllerNumber) || Number(dvd.controllerNumber) < 0))
                || (dvd.controllerLocation !== null && (!Number.isSafeInteger(dvd.controllerLocation) || Number(dvd.controllerLocation) < 0))
                || typeof dvd.mediaAttached !== "boolean";
        })
        || typeof parsed.diagnosticComplete !== "boolean"
        || !Array.isArray(parsed.diagnosticErrors)
        || parsed.diagnosticErrors.length > 16
        || new Set(parsed.diagnosticErrors).size !== parsed.diagnosticErrors.length
        || parsed.diagnosticErrors.some((candidate: unknown) => typeof candidate !== "string" || !diagnosticErrorCodes.has(candidate))
        || parsed.diagnosticComplete !== (parsed.diagnosticErrors.length === 0)) return null;
    return {
        ok: true,
        vmId: parsed.vmId.toLowerCase(),
        vmName: parsed.vmName,
        state: parsed.state,
        uptimeMs: parsed.uptimeMs,
        generation: parsed.generation as 1 | 2 | null,
        secureBootEnabled: parsed.secureBootEnabled as boolean | null,
        heartbeatEnabled: parsed.heartbeatEnabled as boolean | null,
        heartbeatPrimaryStatus: parsed.heartbeatPrimaryStatus as number | null,
        heartbeatSecondaryStatus: parsed.heartbeatSecondaryStatus as number | null,
        integrationServices: parsed.integrationServices.map((candidate: Record<string, unknown>) => ({
            name: candidate.name as string,
            enabled: candidate.enabled as boolean,
            primaryStatus: candidate.primaryStatus as number | null,
            secondaryStatus: candidate.secondaryStatus as number | null,
        })),
        hardDiskCount: parsed.hardDiskCount,
        dvdCount: parsed.dvdCount,
        hardDiskControllers: parsed.hardDiskControllers,
        bootDeviceTypes: parsed.bootDeviceTypes,
        bootEntries: parsed.bootEntries,
        hardDisks: parsed.hardDisks,
        dvdDrives: parsed.dvdDrives,
        diagnosticComplete: parsed.diagnosticComplete,
        diagnosticErrors: parsed.diagnosticErrors,
    };
}
