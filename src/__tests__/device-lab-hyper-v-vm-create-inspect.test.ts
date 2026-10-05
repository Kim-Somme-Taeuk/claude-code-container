import { describe, expect, it } from "vitest";

import { hyperVInspectCreateVhdCommand, parseHyperVCreateVhdInspection } from "@ccc/device-lab/host-control/hyper-v/vm-create-inspect.js";

const BASE = {
    kind: "base" as const,
    executable: "powershell.exe",
    baseImageRoot: "/state/images/hyper-v",
    baseImagePath: "/state/images/hyper-v/base.vhdx",
};
const CLONE = {
    kind: "clone" as const,
    executable: "powershell.exe",
    deviceRoot: "/state/owners/0123456789abcdef/windows-vm/device-1",
    diskPath: "/state/owners/0123456789abcdef/windows-vm/device-1/disks/root.vhdx",
    expectedVirtualSizeBytes: 64 * 1024 * 1024 * 1024,
};

function scriptOf(options: Parameters<typeof hyperVInspectCreateVhdCommand>[0]): string {
    const generated = hyperVInspectCreateVhdCommand(options);
    const encoded = generated.args.find((argument) => /^[A-Za-z0-9+/=]{40,}$/.test(argument));
    return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : generated.input ?? "";
}

describe("read-only VHD inspection during creation", () => {
    it("checks the base VHDX format and parent without changing a file", () => {
        const script = scriptOf(BASE);
        expect(script).toContain("Import-Module Hyper-V");
        expect(script).toContain("Assert-NoReparsePath $VhdPath");
        expect(script).toContain("Get-VHD -Path $VhdPath -ErrorAction Stop");
        expect(script).toContain("$Vhd.VhdFormat -ne 'VHDX'");
        expect(script).toContain("$Vhd.VhdType -eq 'Differencing'");
        expect(script).toContain("$Vhd.ParentPath");
        expect(script).toContain("hyper-v-base-image-parent-invalid");
        expect(script).not.toMatch(/\b(?:New|Set|Remove|Mount|Dismount)-VHD\b/);
        expect(script).not.toContain("Copy-Item");
    });

    it("compares the clone's virtual size with the verified base", () => {
        const script = scriptOf(CLONE);
        expect(script).toContain(`if ([long]$Vhd.Size -ne [long]${CLONE.expectedVirtualSizeBytes})`);
        expect(script).toContain("hyper-v-created-disk-format-mismatch");
        expect(script).toContain("Get-VHD -Path $VhdPath -ErrorAction Stop");
    });

    it("refuses paths outside the matching root and unsupported formats", () => {
        expect(() => hyperVInspectCreateVhdCommand({ ...BASE, baseImagePath: "/elsewhere/base.vhdx" })).toThrow("hyper-v-base-image-path-outside-owner-root");
        expect(() => hyperVInspectCreateVhdCommand({ ...CLONE, diskPath: "/elsewhere/root.vhdx" })).toThrow("hyper-v-disk-path-outside-owner-root");
        expect(() => hyperVInspectCreateVhdCommand({ ...BASE, baseImagePath: "/state/images/hyper-v/base.vhd" })).toThrow("hyper-v-base-image-format-unsupported");
        expect(() => hyperVInspectCreateVhdCommand({ ...CLONE, diskPath: `${CLONE.deviceRoot}/root.vhd` })).toThrow("hyper-v-disk-format-unsupported");
        expect(() => hyperVInspectCreateVhdCommand({ ...CLONE, expectedVirtualSizeBytes: 0 })).toThrow("hyper-v-created-disk-virtual-size-invalid");
    });

    it("reads only a bounded successful inspection result", () => {
        expect(parseHyperVCreateVhdInspection('CCC_HYPER_V_STAGE:hyper-v-base-image-inspection-failed\n{"ok":true,"kind":"base","virtualSizeBytes":68719476736}\n'))
            .toEqual({ ok: true, kind: "base", virtualSizeBytes: 68719476736 });
        for (const output of [
            "not JSON", '{"ok":true,"kind":"clone","virtualSizeBytes":0}',
            '{"ok":true,"kind":"clone","virtualSizeBytes":9007199254740992}',
            '{"ok":true,"kind":"other","virtualSizeBytes":1}',
        ]) expect(parseHyperVCreateVhdInspection(output)).toBe(null);
    });
});
