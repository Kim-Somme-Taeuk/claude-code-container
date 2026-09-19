import { describe, expect, it } from "vitest";

import { hyperVCreatePrologueCommand } from "../host-control/hyper-v/vm-create-prologue.js";
import { parseHyperVCreatePrologueObservation } from "../host-control/hyper-v/observations.js";

// POSIX spellings, as every other host-control test uses: the path validators resolve with
// the running platform's rules, so a Windows literal is not a valid path here.
const OPTIONS = {
    executable: "powershell.exe",
    baseImageRoot: "/state/images/hyper-v",
    baseImagePath: "/state/images/hyper-v/base.vhdx",
    deviceRoot: "/state/owners/0123456789abcdef/windows-vm/device-1",
    diskPath: "/state/owners/0123456789abcdef/windows-vm/device-1/disks/root.vhdx",
};

function scriptOf(options: Partial<typeof OPTIONS> = {}): string {
    const command = hyperVCreatePrologueCommand({ ...OPTIONS, ...options });
    const encoded = command.args?.find((argument) => /^[A-Za-z0-9+/=]{40,}$/.test(argument));
    return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : (command.input ?? "");
}

describe("the create prologue", () => {
    // The whole reason this slice exists: whole-image I/O must not run inside a 120 s
    // per-command clamp. If any of these reappear here, the copy has moved back into
    // PowerShell without anyone noticing.
    it.each(["ComputeHash", "CopyTo", "[IO.File]::Open", "Get-FileHash"])(
        "does no whole-image work: no %s",
        (forbidden) => {
            expect(scriptOf()).not.toContain(forbidden);
        },
    );

    // These two cannot move to Node and are the reason the prologue exists at all.
    it("keeps the reparse assertion on every path creation will touch", () => {
        const script = scriptOf();
        for (const path of ["$BaseImage", "$DeviceRoot", "$DiskDirectory", "$DiskPath"]) {
            expect(script).toContain(`Assert-NoReparsePath ${path}`);
        }
    });

    it("applies the private ACL to both directories", () => {
        const script = scriptOf();
        expect(script).toContain("Set-CccPrivateDirectoryAcl $DeviceRoot");
        expect(script).toContain("Set-CccPrivateDirectoryAcl $DiskDirectory");
        expect(script).toContain("$Acl.SetAccessRuleProtection($true, $false)");
    });

    // The point of this function is that it does not trust Set-Acl. It reads the ACL back and
    // checks every property it just set, because a Set-Acl that silently did not take leaves
    // the device root readable by whatever the parent grants -- and asserting the apply call
    // alone would not notice the read-back disappearing.
    it.each([
        ["inheritance is actually blocked", "if (-not $ObservedAcl.AreAccessRulesProtected)"],
        ["the owner is actually this account", "$ObservedAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value"],
        ["no extra rule survived", "if ($ObservedRules.Count -ne $AllowedSids.Count)"],
        ["each allowed SID appears exactly once", "if ($MatchingRules.Count -ne 1)"],
        ["no rule is inherited or weaker than FullControl", "$ObservedRule.IsInherited -or $ObservedRule.AccessControlType"],
    ])("verifies after setting that %s", (_label, assertion) => {
        expect(scriptOf()).toContain(assertion);
    });

    it("fails the whole prologue when the ACL cannot be proven", () => {
        expect(scriptOf()).toContain("} catch { throw 'hyper-v-device-root-acl-failed' }");
    });

    // The ACL stops trusting inherited permissions. Applied after the copy, a freshly written
    // multi-gigabyte disk would sit under inherited permissions for the copy's duration -- and
    // the copy now happens after this script returns, so "before the copy" means "in here".
    it("applies each ACL immediately after creating its directory", () => {
        const script = scriptOf();
        const createdRoot = script.indexOf("New-Item -ItemType Directory -Path $DeviceRoot");
        const aclRoot = script.indexOf("Set-CccPrivateDirectoryAcl $DeviceRoot");
        const createdDisk = script.indexOf("New-Item -ItemType Directory -Path $DiskDirectory");
        const aclDisk = script.indexOf("Set-CccPrivateDirectoryAcl $DiskDirectory");
        expect(createdRoot).toBeGreaterThan(-1);
        expect(aclRoot).toBeGreaterThan(createdRoot);
        expect(createdDisk).toBeGreaterThan(aclRoot);
        expect(aclDisk).toBeGreaterThan(createdDisk);
    });

    // After `New-Item -Force` the answer is always yes, so reading it afterwards would record
    // that creation made a device root it actually found -- and compensation would delete it.
    it("reads whether the directories existed before creating them", () => {
        const script = scriptOf();
        const readRoot = script.indexOf("$DeviceRootExisted = [bool](Test-Path -LiteralPath $DeviceRoot)");
        const readDisk = script.indexOf("$DiskDirectoryExisted = [bool](Test-Path -LiteralPath $DiskDirectory)");
        const created = script.indexOf("New-Item -ItemType Directory");
        expect(readRoot).toBeGreaterThan(-1);
        expect(created).toBeGreaterThan(readRoot);
        expect(created).toBeGreaterThan(readDisk);
    });

    // No Hyper-V cmdlet runs here. Importing the module anyway would make a host with a broken
    // Hyper-V installation fail during directory creation, naming the wrong cause.
    it("does not import Hyper-V, because it issues no Hyper-V cmdlet", () => {
        expect(scriptOf()).not.toContain("Import-Module Hyper-V");
    });

    it("refuses a base image outside the image root", () => {
        expect(() => scriptOf({ baseImagePath: "/elsewhere/base.vhdx" })).toThrow();
    });

    it("refuses a disk outside the device root", () => {
        expect(() => scriptOf({ diskPath: "/elsewhere/root.vhdx" })).toThrow();
    });

    it.each([
        ["a base image that is not a VHDX", { baseImagePath: "/state/images/hyper-v/base.vhd" }],
        ["a disk that is not a VHDX", { diskPath: "/state/owners/0123456789abcdef/windows-vm/device-1/disks/root.vhd" }],
    ])("refuses %s", (_label, override) => {
        expect(() => scriptOf(override)).toThrow(/format-unsupported/);
    });
});

describe("reading what the prologue created", () => {
    const observation = JSON.stringify({
        ok: true,
        deviceRootExisted: false,
        diskDirectoryExisted: true,
        deviceRoot: "/state/devices/device-1",
        diskDirectory: "/state/devices/device-1/disks",
    });

    it("decodes both booleans and both paths", () => {
        expect(parseHyperVCreatePrologueObservation(observation)).toEqual({
            ok: true,
            deviceRootExisted: false,
            diskDirectoryExisted: true,
            deviceRoot: "/state/devices/device-1",
            diskDirectory: "/state/devices/device-1/disks",
        });
    });

    // Defaulting either boolean would have to pick one of two wrong answers: true leaves a
    // device root creation made, false deletes one it found. Refusing is the only honest
    // outcome when the host did not say.
    it.each([
        ["no ok flag", { deviceRootExisted: false, diskDirectoryExisted: false, deviceRoot: "a", diskDirectory: "b" }],
        ["a missing deviceRootExisted", { ok: true, diskDirectoryExisted: false, deviceRoot: "a", diskDirectory: "b" }],
        ["a missing diskDirectoryExisted", { ok: true, deviceRootExisted: false, deviceRoot: "a", diskDirectory: "b" }],
        ["a non-boolean existence flag", { ok: true, deviceRootExisted: "no", diskDirectoryExisted: false, deviceRoot: "a", diskDirectory: "b" }],
        ["an empty deviceRoot", { ok: true, deviceRootExisted: false, diskDirectoryExisted: false, deviceRoot: "", diskDirectory: "b" }],
    ])("refuses an observation with %s rather than guessing", (_label, payload) => {
        expect(parseHyperVCreatePrologueObservation(JSON.stringify(payload))).toBe(null);
    });

    it("refuses output that is not JSON at all", () => {
        expect(parseHyperVCreatePrologueObservation("not json")).toBe(null);
    });
});
