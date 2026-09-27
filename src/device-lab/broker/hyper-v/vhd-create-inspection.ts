import { win32 } from "path";

import type { HyperVVirtualHardDisk } from "../../../hyper-v-windows/low-level/index.js";
import { HyperVWindowsError } from "../../../hyper-v-windows/low-level/index.js";

export type HyperVCreateVhdTarget =
    | { readonly kind: "base"; readonly path: string }
    | { readonly kind: "clone"; readonly path: string; readonly expectedVirtualSizeBytes: number };

function sameWindowsPath(left: string, right: string): boolean {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** Applies Device Lab image policy to native Get-VHD metadata. */
export function inspectHyperVCreateVhd(
    target: HyperVCreateVhdTarget,
    vhd: HyperVVirtualHardDisk,
): number {
    const mismatch = target.kind === "base"
        ? "hyper-v-base-image-parent-invalid"
        : "hyper-v-created-disk-format-mismatch";
    if (!sameWindowsPath(vhd.path, target.path)
        || vhd.vhdFormat !== "VHDX"
        || vhd.vhdType === "Differencing"
        || vhd.parentPath !== null
        || !Number.isSafeInteger(vhd.virtualSizeBytes)
        || vhd.virtualSizeBytes <= 0
        || (target.kind === "clone" && vhd.virtualSizeBytes !== target.expectedVirtualSizeBytes)) {
        throw new Error(mismatch);
    }
    return vhd.virtualSizeBytes;
}

/**
 * Keeps the existing bounded creation-stage diagnostic when a typed read fails. The typed failure
 * stays attached as `cause`, so the create's 502 still names Get-VHD as the failing operation;
 * its native code is not carried into the stage code.
 */
export function hyperVCreateVhdReadError(kind: "base" | "clone", error: unknown): Error {
    if (!(error instanceof HyperVWindowsError)) return error instanceof Error ? error : new Error("hyper-v-vm-disk-inspection-failed");
    if (error.category === "native" && error.code === "vhd-not-found") {
        return new Error(kind === "base" ? "hyper-v-base-image-not-found" : "hyper-v-created-disk-not-found", { cause: error });
    }
    if (error.category === "native" && error.code === "vhd-path-reparse-point-rejected") {
        return new Error("hyper-v-path-reparse-point-rejected", { cause: error });
    }
    return new Error(kind === "base" ? "hyper-v-base-image-inspection-failed" : "hyper-v-vm-disk-create-failed", { cause: error });
}
