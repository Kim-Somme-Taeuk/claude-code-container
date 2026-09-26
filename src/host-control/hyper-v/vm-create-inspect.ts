import type { HyperVProviderCommand } from "./contracts.js";
import { assertPathInside, boundedInteger, command, jsonScript, psQuote } from "./core.js";

export type HyperVCreateVhdInspectionOptions =
    | {
        readonly kind: "base";
        readonly executable: string;
        readonly baseImageRoot: string;
        readonly baseImagePath: string;
    }
    | {
        readonly kind: "clone";
        readonly executable: string;
        readonly deviceRoot: string;
        readonly diskPath: string;
        readonly expectedVirtualSizeBytes: number;
    };

export type HyperVCreateVhdInspection = {
    readonly ok: true;
    readonly kind: "base" | "clone";
    readonly virtualSizeBytes: number;
};

/** A read-only Get-VHD bridge until VHD primitives move into the typed library. */
export function hyperVInspectCreateVhdCommand(options: HyperVCreateVhdInspectionOptions): HyperVProviderCommand {
    const base = options.kind === "base";
    const path = base
        ? assertPathInside(options.baseImageRoot, options.baseImagePath, "base-image-path")
        : assertPathInside(options.deviceRoot, options.diskPath, "disk-path");
    if (!/\.vhdx$/i.test(path)) {
        throw new Error(base ? "hyper-v-base-image-format-unsupported" : "hyper-v-disk-format-unsupported");
    }
    const expectedVirtualSizeBytes = base
        ? null
        : boundedInteger(options.expectedVirtualSizeBytes, 1, Number.MAX_SAFE_INTEGER, "created-disk-virtual-size");
    const mismatch = base ? "hyper-v-base-image-parent-invalid" : "hyper-v-created-disk-format-mismatch";
    const notFound = base ? "hyper-v-base-image-not-found" : "hyper-v-created-disk-not-found";
    const script = jsonScript([
        `$VhdPath = ${psQuote(path)}`,
        "Assert-NoReparsePath $VhdPath",
        `if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) { throw '${notFound}' }`,
        "$Vhd = Get-VHD -Path $VhdPath -ErrorAction Stop",
        `if ([string]$Vhd.VhdFormat -ne 'VHDX' -or [string]$Vhd.VhdType -eq 'Differencing' -or $Vhd.ParentPath) { throw '${mismatch}' }`,
        ...(!base ? [`if ([long]$Vhd.Size -ne [long]${expectedVirtualSizeBytes}) { throw '${mismatch}' }`] : []),
        "Assert-NoReparsePath $VhdPath",
        `$Result = [ordered]@{ ok = $true; kind = '${options.kind}'; virtualSizeBytes = [long]$Vhd.Size }`,
        "$Result | ConvertTo-Json -Compress -Depth 3",
    ], base ? "hyper-v-base-image-inspection-failed" : "hyper-v-vm-disk-create-failed");
    return command(options.executable, script);
}

export function parseHyperVCreateVhdInspection(stdout: string): HyperVCreateVhdInspection | null {
    const lastLine = stdout.trim().split(/\r?\n/).at(-1);
    if (!lastLine) return null;
    let value: unknown;
    try { value = JSON.parse(lastLine); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    if (result.ok !== true || (result.kind !== "base" && result.kind !== "clone")) return null;
    if (!Number.isSafeInteger(result.virtualSizeBytes) || (result.virtualSizeBytes as number) <= 0) return null;
    return { ok: true, kind: result.kind, virtualSizeBytes: result.virtualSizeBytes as number };
}
