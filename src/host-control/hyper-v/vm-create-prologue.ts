import { type HyperVProviderCommand } from "./contracts.js";
import { dirname, resolve } from "path";
import { psQuote, assertPlainPath, assertPathInside, jsonScript, command } from "./core.js";

export type HyperVCreatePrologueOptions = {
    executable: string;
    baseImageRoot: string;
    baseImagePath: string;
    deviceRoot: string;
    diskPath: string;
};

/**
 * Everything creation must do on the host before a single byte is copied, and nothing else.
 *
 * This exists because two of the things it does cannot move to Node, and one of them must
 * happen before the copy rather than after it.
 *
 * `Assert-NoReparsePath` tests `FileAttributes::ReparsePoint`, which catches every reparse
 * tag. Node's nearest equivalent tests `isSymbolicLink()`, and libuv maps only
 * `IO_REPARSE_TAG_SYMLINK` and `IO_REPARSE_TAG_MOUNT_POINT` to that -- an APPEXECLINK, a WCI
 * placeholder or a dedup reparse looks like an ordinary file. `fs.constants.O_NOFOLLOW` is
 * undefined on Windows too, so the NOFOLLOW opens elsewhere in this codebase degrade to plain
 * opens on the one platform that matters. There is no native module available to close the
 * gap: this repository has no runtime dependencies at all. So the reparse check stays here.
 *
 * `Set-CccPrivateDirectoryAcl` has no Node equivalent for the same reason, and it must run
 * before the copy rather than after. It calls `SetAccessRuleProtection($true, $false)`, whose
 * entire purpose is to stop trusting inherited permissions. Applied afterwards, a freshly
 * written multi-gigabyte disk would sit under inherited permissions for as long as the copy
 * takes.
 *
 * It reports which directories it created. That is not bookkeeping: the process that creates
 * them is no longer the process that must remove them on failure, and compensation may only
 * remove what creation actually made. `hyperVRecoverOrphanCommand`, the broker's own rollback,
 * removes disks and media and never directories, so nothing else covers this.
 */
export function hyperVCreatePrologueCommand(options: HyperVCreatePrologueOptions): HyperVProviderCommand {
    const baseImagePath = assertPathInside(options.baseImageRoot, options.baseImagePath, "base-image-path");
    if (!/\.vhdx$/i.test(baseImagePath)) throw new Error("hyper-v-base-image-format-unsupported");
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const diskPath = assertPathInside(deviceRoot, String(options.diskPath || ""), "disk-path");
    if (!/\.vhdx$/i.test(diskPath)) throw new Error("hyper-v-disk-format-unsupported");

    const lines = [
        `$BaseImage = ${psQuote(baseImagePath)}`,
        `$DeviceRoot = ${psQuote(deviceRoot)}`,
        `$DiskPath = ${psQuote(diskPath)}`,
        "$DiskDirectory = Split-Path -Parent $DiskPath",
        "function Set-CccPrivateDirectoryAcl([string]$Path) {",
        "  try {",
        "    $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        "    $AllowedSids = @($CurrentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
        "    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
        "    $Acl = Get-Acl -LiteralPath $Path -ErrorAction Stop",
        "    $Acl.SetAccessRuleProtection($true, $false)",
        "    foreach ($Rule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleAll($Rule) }",
        "    $Acl.SetOwner($CurrentSid)",
        "    foreach ($Sid in $AllowedSids) {",
        "      $Rule = [Security.AccessControl.FileSystemAccessRule]::new($Sid, [Security.AccessControl.FileSystemRights]::FullControl, $Inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
        "      [void]$Acl.AddAccessRule($Rule)",
        "    }",
        "    Set-Acl -LiteralPath $Path -AclObject $Acl -ErrorAction Stop",
        "    $ObservedAcl = Get-Acl -LiteralPath $Path -ErrorAction Stop",
        "    if (-not $ObservedAcl.AreAccessRulesProtected) { throw 'hyper-v-device-root-acl-failed' }",
        "    if ($ObservedAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid.Value) { throw 'hyper-v-device-root-acl-failed' }",
        "    $ObservedRules = @($ObservedAcl.Access)",
        "    if ($ObservedRules.Count -ne $AllowedSids.Count) { throw 'hyper-v-device-root-acl-failed' }",
        "    foreach ($AllowedSid in $AllowedSids) {",
        "      $MatchingRules = @($ObservedRules | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $AllowedSid.Value })",
        "      if ($MatchingRules.Count -ne 1) { throw 'hyper-v-device-root-acl-failed' }",
        "    }",
        "    foreach ($ObservedRule in $ObservedRules) {",
        "      $ObservedSid = $ObservedRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
        "      if ($AllowedSids.Value -notcontains $ObservedSid -or $ObservedRule.IsInherited -or $ObservedRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$ObservedRule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or $ObservedRule.InheritanceFlags -ne $Inheritance -or $ObservedRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'hyper-v-device-root-acl-failed' }",
        "    }",
        "  } catch { throw 'hyper-v-device-root-acl-failed' }",
        "}",
        "$env:CCC_HYPER_V_STAGE = 'hyper-v-vm-path-inspection-failed'",
        "Assert-NoReparsePath $BaseImage",
        "Assert-NoReparsePath $DeviceRoot",
        "Assert-NoReparsePath $DiskDirectory",
        "Assert-NoReparsePath $DiskPath",
        "if (-not (Test-Path -LiteralPath $BaseImage -PathType Leaf)) { throw 'hyper-v-base-image-not-found' }",
        // Read before creating anything, because after `New-Item -Force` the answer is always
        // yes and the difference between a directory creation made and one found is the whole
        // basis of compensation.
        "$DeviceRootExisted = [bool](Test-Path -LiteralPath $DeviceRoot)",
        "$DiskDirectoryExisted = [bool](Test-Path -LiteralPath $DiskDirectory)",
        // No result can reach Node if an ACL or path check below fails. The command itself
        // must remove only the directories it made; Node cannot infer effects from silence.
        "try {",
        "  $env:CCC_HYPER_V_STAGE = 'hyper-v-device-root-acl-failed'",
        "  New-Item -ItemType Directory -Path $DeviceRoot -Force | Out-Null",
        "  Set-CccPrivateDirectoryAcl $DeviceRoot",
        // Re-checked after the device root exists: creating it may have followed a component
        // that was fine a moment ago, and the disk directory is created next.
        "  Assert-NoReparsePath $DiskDirectory",
        "  New-Item -ItemType Directory -Path $DiskDirectory -Force | Out-Null",
        "  Set-CccPrivateDirectoryAcl $DiskDirectory",
        "} catch {",
        "  $PrimaryError = $_",
        "  $DiskDirectoryRemaining = $false",
        "  $DeviceRootRemaining = $false",
        "  try { if (-not $DiskDirectoryExisted) { Assert-NoReparsePath $DiskDirectory; if (Test-Path -LiteralPath $DiskDirectory) { Remove-Item -LiteralPath $DiskDirectory -Force -ErrorAction Stop } } } catch { $DiskDirectoryRemaining = $true }",
        "  try { if (-not $DeviceRootExisted) { Assert-NoReparsePath $DeviceRoot; if (Test-Path -LiteralPath $DeviceRoot) { Remove-Item -LiteralPath $DeviceRoot -Force -ErrorAction Stop } } } catch { $DeviceRootRemaining = $true }",
        "  $Partial = [ordered]@{ ok = $false; deviceRoot = $DeviceRoot; diskDirectory = $DiskDirectory; deviceRootRemaining = $DeviceRootRemaining; diskDirectoryRemaining = $DiskDirectoryRemaining }",
        "  $Partial | ConvertTo-Json -Compress -Depth 3",
        "  throw $PrimaryError",
        "}",
        "$Result = [ordered]@{ ok = $true; deviceRootExisted = $DeviceRootExisted; diskDirectoryExisted = $DiskDirectoryExisted; deviceRoot = $DeviceRoot; diskDirectory = $DiskDirectory }",
        "$Result | ConvertTo-Json -Compress -Depth 3",
    ];
    // No Hyper-V cmdlet runs here, so the module is not imported. Keeping it out means a host
    // whose Hyper-V module is broken still fails on the operation that needs it rather than on
    // directory creation, which would name the wrong cause.
    return command(options.executable, jsonScript(lines, "hyper-v-vm-path-inspection-failed", true));
}

export type HyperVCreatePrologueFailure = {
    readonly ok: false;
    readonly deviceRoot: string;
    readonly diskDirectory: string;
    readonly deviceRootRemaining: boolean;
    readonly diskDirectoryRemaining: boolean;
};

/** Reports only directories whose self-cleanup failed after a prologue error. */
export function parseHyperVCreatePrologueFailure(stdout: string): HyperVCreatePrologueFailure | null {
    const last = stdout.trim().split(/\r?\n/).at(-1);
    if (!last) return null;
    let value: unknown;
    try { value = JSON.parse(last); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    if (result.ok !== false || typeof result.deviceRoot !== "string" || !result.deviceRoot
        || typeof result.diskDirectory !== "string" || !result.diskDirectory
        || typeof result.deviceRootRemaining !== "boolean"
        || typeof result.diskDirectoryRemaining !== "boolean") return null;
    return result as HyperVCreatePrologueFailure;
}

/** Removes one creation effect only after a native all-tag reparse check. */
export function hyperVCreateCompensationCommand(options: {
    readonly executable: string;
    readonly deviceRoot: string;
    readonly diskPath: string;
    readonly kind: "delete-file" | "delete-directory";
    readonly path: string;
}): HyperVProviderCommand {
    const deviceRoot = assertPlainPath(options.deviceRoot, "device-root");
    const diskPath = assertPathInside(deviceRoot, options.diskPath, "disk-path");
    const target = assertPlainPath(options.path, "compensation-path");
    const expected = options.kind === "delete-file"
        ? [diskPath]
        : [dirname(diskPath), deviceRoot];
    if (!expected.some((path) => resolve(path) === resolve(target))) {
        throw new Error("hyper-v-create-compensation-path-invalid");
    }
    const lines = [
        `$DeviceRoot = ${psQuote(deviceRoot)}`,
        `$Target = ${psQuote(target)}`,
        "Assert-NoReparsePath $DeviceRoot",
        "Assert-NoReparsePath $Target",
        "$Item = Get-Item -LiteralPath $Target -Force -ErrorAction Stop",
        ...(options.kind === "delete-file"
            ? ["if ($Item.PSIsContainer) { throw 'hyper-v-create-compensation-path-invalid' }"]
            : [
                "if (-not $Item.PSIsContainer) { throw 'hyper-v-create-compensation-path-invalid' }",
                "if (@(Get-ChildItem -LiteralPath $Target -Force -ErrorAction Stop | Select-Object -First 1).Count -ne 0) { throw 'hyper-v-create-compensation-directory-not-empty' }",
            ]),
        "Remove-Item -LiteralPath $Target -Force -ErrorAction Stop",
        "@{ ok = $true } | ConvertTo-Json -Compress",
    ];
    return command(options.executable, jsonScript(lines, "hyper-v-create-compensation-failed", true));
}
