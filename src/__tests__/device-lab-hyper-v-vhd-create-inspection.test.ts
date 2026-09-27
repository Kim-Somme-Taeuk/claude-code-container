import { describe, expect, it } from "vitest";

import { hyperVCreateVhdReadError, inspectHyperVCreateVhd } from "../device-lab/broker/hyper-v/vhd-create-inspection.js";
import { HyperVWindowsError } from "../hyper-v-windows/low-level/index.js";

const path = "C:\\owners\\abc\\root.vhdx";
const metadata = {
    path, vhdFormat: "VHDX", vhdType: "Dynamic", parentPath: null,
    virtualSizeBytes: 64 * 1024 * 1024 * 1024, fileSizeBytes: 4096,
};

describe("Device Lab typed Get-VHD creation policy", () => {
    it("maps typed read failures to bounded base and clone diagnostics", () => {
        const native = new HyperVWindowsError({ category: "native", operation: "Get-VHD", code: "vhd-not-found" });
        const protocol = new HyperVWindowsError({ category: "protocol", operation: "Get-VHD", code: "response-malformed" });
        expect(hyperVCreateVhdReadError("base", native).message).toBe("hyper-v-base-image-not-found");
        expect(hyperVCreateVhdReadError("clone", native).message).toBe("hyper-v-created-disk-not-found");
        expect(hyperVCreateVhdReadError("base", protocol).message).toBe("hyper-v-base-image-inspection-failed");
        expect(hyperVCreateVhdReadError("clone", protocol).message).toBe("hyper-v-vm-disk-create-failed");
        // The typed failure stays attached so the 502 can still name Get-VHD.
        for (const [kind, typed] of [["base", native], ["clone", protocol]] as const) {
            expect(hyperVCreateVhdReadError(kind, typed).cause).toBe(typed);
        }
    });
    it("accepts the expected base and exact clone virtual size", () => {
        expect(inspectHyperVCreateVhd({ kind: "base", path }, metadata)).toBe(metadata.virtualSizeBytes);
        expect(inspectHyperVCreateVhd({ kind: "clone", path, expectedVirtualSizeBytes: metadata.virtualSizeBytes }, metadata)).toBe(metadata.virtualSizeBytes);
    });

    it.each([
        ["wrong path", { path: "C:\\foreign\\root.vhdx" }],
        ["wrong format", { vhdFormat: "VHD" }],
        ["differencing", { vhdType: "Differencing" }],
        ["parent chain", { parentPath: "C:\\foreign\\parent.vhdx" }],
        ["invalid virtual size", { virtualSizeBytes: 0 }],
    ])("rejects a base with %s", (_label, changed) => {
        expect(() => inspectHyperVCreateVhd({ kind: "base", path }, { ...metadata, ...changed }))
            .toThrow("hyper-v-base-image-parent-invalid");
    });

    it("rejects a copied disk with a different virtual size", () => {
        expect(() => inspectHyperVCreateVhd({ kind: "clone", path, expectedVirtualSizeBytes: metadata.virtualSizeBytes + 1 }, metadata))
            .toThrow("hyper-v-created-disk-format-mismatch");
    });
});
