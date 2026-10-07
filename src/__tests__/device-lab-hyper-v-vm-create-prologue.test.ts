import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";

import { hyperVCreateCompensationCommand, hyperVCreatePrologueCommand, parseHyperVCreatePrologueFailure } from "@ccc/device-lab/host-control/hyper-v/vm-create-prologue.js";
import { parseHyperVCreatePrologueObservation } from "@ccc/device-lab/host-control/hyper-v/observations.js";

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

    it("cleans only newly created empty directories on a failure before the result", () => {
        const script = scriptOf();
        const catchStart = script.indexOf("} catch {\n  $PrimaryError = $_");
        const resultStart = script.indexOf("$Result = [ordered]@");
        expect(catchStart).toBeGreaterThan(script.indexOf("New-Item -ItemType Directory -Path $DiskDirectory"));
        expect(resultStart).toBeGreaterThan(catchStart);
        const cleanup = script.slice(catchStart, resultStart);
        expect(cleanup).toContain("if (-not $DiskDirectoryExisted)");
        expect(cleanup).toContain("if (-not $DeviceRootExisted)");
        expect(cleanup).toContain("Assert-NoReparsePath $DiskDirectory");
        expect(cleanup).toContain("Assert-NoReparsePath $DeviceRoot");
        expect(cleanup).not.toContain("-Recurse");
        expect(cleanup).toContain("deviceRootRemaining = $DeviceRootRemaining");
        expect(cleanup).toContain("diskDirectoryRemaining = $DiskDirectoryRemaining");
        expect(cleanup).toContain("$Partial | ConvertTo-Json -Compress -Depth 3");
        expect(cleanup).toContain("throw $PrimaryError");
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

describe("native create compensation", () => {
    it.each(["delete-file", "delete-directory"] as const)("checks every reparse tag before %s removal", (kind) => {
        const target = kind === "delete-file" ? OPTIONS.diskPath : `${OPTIONS.deviceRoot}/disks`;
        const command = hyperVCreateCompensationCommand({
            executable: OPTIONS.executable, deviceRoot: OPTIONS.deviceRoot,
            diskPath: OPTIONS.diskPath, kind, path: target,
        });
        const encoded = command.args?.find((argument) => /^[A-Za-z0-9+/=]{40,}$/.test(argument));
        const script = encoded ? Buffer.from(encoded, "base64").toString("utf16le") : (command.input ?? "");
        expect(script).toContain("Assert-NoReparsePath $DeviceRoot");
        expect(script).toContain("Assert-NoReparsePath $Target");
        expect(script.indexOf("Remove-Item -LiteralPath $Target")).toBeGreaterThan(script.indexOf("Assert-NoReparsePath $Target"));
        expect(script).not.toContain("Remove-Item -LiteralPath $Target -Recurse");
        if (kind === "delete-directory") expect(script).toContain("Get-ChildItem -LiteralPath $Target -Force");
    });

    it("rejects a path outside the new device root", () => {
        expect(() => hyperVCreateCompensationCommand({
            executable: OPTIONS.executable, deviceRoot: OPTIONS.deviceRoot,
            diskPath: OPTIONS.diskPath, kind: "delete-file", path: "/state/foreign.vhdx",
        })).toThrow("hyper-v-create-compensation-path-invalid");
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

describe("reading incomplete prologue cleanup", () => {
    it("identifies only the directory still needing compensation", () => {
        const partial = JSON.stringify({ ok: false, deviceRoot: OPTIONS.deviceRoot, diskDirectory: "/state/owners/0123456789abcdef/windows-vm/device-1/disks", deviceRootRemaining: true, diskDirectoryRemaining: false });
        expect(parseHyperVCreatePrologueFailure(`CCC_HYPER_V_STAGE:hyper-v-vm-path-inspection-failed\n${partial}`)).toEqual(JSON.parse(partial));
        expect(parseHyperVCreatePrologueFailure('{"ok":false,"deviceRootRemaining":true}')).toBeNull();
    });
});


const aclPowerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasAclPowerShell = spawnSync(aclPowerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 5000 }).status === 0;

it.skipIf(!hasAclPowerShell).each(["S-1-5-18", "S-1-5-32-544", "S-1-5-21-111-222-333-1001"])("prologue grants each distinct SID once when run as %s", (currentSid) => {
    const script = scriptOf();
    // Replace Windows-only SID constructors, preserving the generated enumeration.
    const selection = script.split("\n").find((line) => line.includes("$AllowedSids ="))!
        .replace(/\[Security\.Principal\.SecurityIdentifier\]::new\('([^']+)'\)/g, "([pscustomobject]@{Value='$1'})");
    const loop = script.match(/foreach \(\$Sid in \$AllowedSids\)/)?.[0];
    const countCheck = script.split("\n").find((line) => line.includes("if ($ObservedRules.Count -ne $AllowedSids.Count)"));
    expect(loop).toBeDefined();
    expect(countCheck).toBeDefined();
    const program = [
        "$ErrorActionPreference = 'Stop'",
        `$CurrentSid = [pscustomobject]@{Value='${currentSid}'}`,
        selection,
        `$Installed = @(${loop} { $Sid.Value })`,
        "$ObservedRules = @($Installed | Sort-Object -Unique)",
        countCheck,
        "$RejectedExtra = $false; $ObservedRules += 'S-1-1-0'",
        `try { ${countCheck} } catch { $RejectedExtra = $true }`,
        "@{ installed=$Installed; rejectedExtra=$RejectedExtra } | ConvertTo-Json -Compress",
    ].join("\n");
    const result = spawnSync(aclPowerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    const observation = JSON.parse(result.stdout);
    expect(observation.installed).toEqual([...new Set([currentSid, "S-1-5-18", "S-1-5-32-544"])].sort());
    expect(observation.rejectedExtra).toBe(true);
});
