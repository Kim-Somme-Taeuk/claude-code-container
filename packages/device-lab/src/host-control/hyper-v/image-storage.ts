import { win32 } from "path";

import type { HyperVProviderCommand } from "./contracts.js";
import { assertPathInside, command, jsonScript, psQuote } from "./core.js";

export type HyperVImportedImageStorageObservation = {
    readonly attached: boolean;
    readonly partitionStyle: string | null;
};

/** Reads the Storage-module view of an owner-staged VHDX; no Hyper-V cmdlet runs here. */
export function hyperVImportedImageStorageCommand(options: {
    readonly executable: string;
    readonly imageRoot: string;
    readonly path: string;
    readonly readPartitionStyle: boolean;
}): HyperVProviderCommand {
    const path = assertPathInside(options.imageRoot, options.path, "base-image-storage");
    if (!/\.vhdx$/i.test(path)) throw new Error("hyper-v-base-image-format-unsupported");
    const script = jsonScript([
        `$VhdPath = ${psQuote(path)}`,
        `$ReadPartitionStyle = $${options.readPartitionStyle ? "true" : "false"}`,
        "Assert-NoReparsePath $VhdPath",
        "Import-Module Storage -ErrorAction Stop",
        "$Images = @(Storage\\Get-DiskImage -ImagePath $VhdPath -ErrorAction Stop)",
        "if ($Images.Count -ne 1) { throw 'hyper-v-base-image-storage-ambiguous' }",
        "$Image = $Images[0]",
        "if ([string]$Image.ImagePath -ne $VhdPath) { throw 'hyper-v-base-image-storage-path-mismatch' }",
        "$Attached = [bool]$Image.Attached",
        "$PartitionStyle = $null",
        "if ($ReadPartitionStyle) {",
        "  if (-not $Attached) { throw 'hyper-v-base-image-not-mounted' }",
        "  $Disks = @($Image | Storage\\Get-Disk -ErrorAction Stop)",
        "  if ($Disks.Count -ne 1) { throw 'hyper-v-base-image-storage-ambiguous' }",
        "  $PartitionStyle = [string]$Disks[0].PartitionStyle",
        "}",
        "Assert-NoReparsePath $VhdPath",
        "$Result = [ordered]@{ ok = $true; path = $VhdPath; attached = $Attached; partitionStyle = $PartitionStyle }",
        "$Result | ConvertTo-Json -Compress -Depth 3",
    ], "hyper-v-base-image-inspection-failed", true);
    return command(options.executable, script);
}

export function parseHyperVImportedImageStorage(
    stdout: string,
    expectedPath: string,
): HyperVImportedImageStorageObservation | null {
    const line = stdout.trim().split(/\r?\n/).at(-1);
    if (!line) return null;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    if (Object.keys(result).sort().join(",") !== "attached,ok,partitionStyle,path"
        || result.ok !== true || typeof result.path !== "string"
        || win32.normalize(result.path).toLowerCase() !== win32.normalize(expectedPath).toLowerCase()
        || typeof result.attached !== "boolean"
        || (result.partitionStyle !== null && (typeof result.partitionStyle !== "string" || result.partitionStyle.length > 64))) {
        return null;
    }
    return { attached: result.attached, partitionStyle: result.partitionStyle as string | null };
}
