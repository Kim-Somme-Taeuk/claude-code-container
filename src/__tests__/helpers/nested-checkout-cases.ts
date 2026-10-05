/** Executed against the production PowerShell helper locally and on the native guest. */
export interface NestedCheckoutCase {
    readonly name: string;
    readonly body: string;
    readonly expected: Readonly<Record<string, unknown>>;
    readonly windowsOnly?: boolean;
    readonly requiresSymbolicLink?: boolean;
}

export function nestedCheckoutFixtureSetup(linkType: "Junction" | "SymbolicLink"): string {
    return `
$WorkspacePairs=@(
    @{name='hyper-v';target='packages/hyper-v'},
    @{name='device-lab';target='packages/device-lab'},
    @{name='device-lab-mcp';target='device-lab-mcp'}
)
function New-WorkspaceFixture {
    [IO.Directory]::CreateDirectory((Join-Path $Source 'node_modules/@ccc')) | Out-Null
    foreach ($Pair in $WorkspacePairs) {
        $Target=Join-Path $Source $Pair.target
        [IO.Directory]::CreateDirectory($Target) | Out-Null
        Set-Content -LiteralPath (Join-Path $Target 'workspace-sentinel') -Value $Pair.name -Encoding ASCII
    }
    Set-Content -LiteralPath (Join-Path $Source 'source-sentinel') -Value 'keep' -Encoding ASCII
}
function Add-WorkspaceLink([string]$Name,[string]$Target) {
    New-Item -ItemType ${linkType} -Path (Join-Path $Source ('node_modules/@ccc/'+$Name)) -Target $Target | Out-Null
}
function Add-AllWorkspaceLinks {
    foreach ($Pair in $WorkspacePairs) { Add-WorkspaceLink $Pair.name (Join-Path $Source $Pair.target) }
}
function Invoke-RejectedCleanup {
    try { Clear-NestedCheckout $Source;return '' } catch { return $_.Exception.Message }
}
function Test-OwnershipPreserved {
    return (Test-Path -LiteralPath $Source -PathType Container) -and (Test-Path -LiteralPath $Marker -PathType Leaf) -and (([IO.File]::ReadAllText($Marker)).Trim() -eq ('a'*32))
}
function Test-SourcePreserved {
    return (Test-OwnershipPreserved) -and (Test-Path -LiteralPath (Join-Path $Source 'source-sentinel') -PathType Leaf) -and (([IO.File]::ReadAllText((Join-Path $Source 'source-sentinel'))).Trim() -eq 'keep')
}
`;
}

const rejected = { code: "nested-checkout-reparse-point", kept: true } as const;

export function nestedCheckoutCases(linkType: "Junction" | "SymbolicLink"): readonly NestedCheckoutCase[] {
    const createLink = (path: string, target: string) => `New-Item -ItemType ${linkType} -Path ${path} -Target ${target} | Out-Null`;
    const rejection = (setup: string, kept = "Test-SourcePreserved") => `
New-WorkspaceFixture
${setup}
$Code=Invoke-RejectedCleanup
@{code=$Code;kept=(${kept})}|ConvertTo-Json -Compress
`;
    return [
        {
            name: "clears two ordinary runs while retaining the root and ownership marker",
            body: `
foreach ($Cycle in 1..2) {
    [IO.Directory]::CreateDirectory((Join-Path $Source 'nested')) | Out-Null
    Set-Content -LiteralPath (Join-Path $Source 'nested/file') -Value 'old source'
    Clear-NestedCheckout $Source
}
@{root=(Test-Path -LiteralPath $Source -PathType Container);children=@(Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {$_.Name});marker=([IO.File]::ReadAllText($Marker)).Trim()}|ConvertTo-Json -Compress
`,
            expected: { root: true, children: [".ccc-nested-checkout"], marker: "a".repeat(32) },
        },
        ...(["missing", "directory", "invalid"] as const).map(kind => ({
            name: `rejects a ${kind} marker before deleting contents`,
            body: `
Remove-Item -LiteralPath $Marker -Force
${kind === "directory" ? "[IO.Directory]::CreateDirectory($Marker) | Out-Null" : kind === "invalid" ? "Set-Content -LiteralPath $Marker -Value 'unknown'" : ""}
Set-Content -LiteralPath (Join-Path $Source 'sentinel') -Value 'keep'
$Code=Invoke-RejectedCleanup
@{code=$Code;preserved=(Test-Path -LiteralPath (Join-Path $Source 'sentinel'))}|ConvertTo-Json -Compress
`,
            expected: { code: "nested-checkout-not-owned", preserved: true },
        })),
        {
            name: "preserves ownership when ordinary child deletion fails",
            body: `
Set-Content -LiteralPath (Join-Path $Source 'busy') -Value 'keep'
function Remove-Item { throw 'simulated-child-busy' }
$Code=Invoke-RejectedCleanup
@{code=$Code;root=(Test-Path -LiteralPath $Source);marker=([IO.File]::ReadAllText($Marker)).Trim()}|ConvertTo-Json -Compress
`,
            expected: { code: "simulated-child-busy", root: true, marker: "a".repeat(32) },
        },
        {
            name: "clears the three exact workspace links before ordinary cleanup and repeats safely",
            body: `
$script:ObservedUnlink=$false
foreach ($Cycle in 1..2) {
    New-WorkspaceFixture
    Add-AllWorkspaceLinks
    function Remove-Item {
        [CmdletBinding()]param([string]$LiteralPath,[switch]$Recurse,[switch]$Force)
        if (-not $script:ObservedUnlink) {
            foreach ($Pair in $WorkspacePairs) {
                if (Test-Path -LiteralPath (Join-Path $Source ('node_modules/@ccc/'+$Pair.name))) { throw 'workspace-link-not-unlinked-first' }
                if (([IO.File]::ReadAllText((Join-Path (Join-Path $Source $Pair.target) 'workspace-sentinel'))).Trim() -ne $Pair.name) { throw 'workspace-target-followed-during-unlink' }
            }
            $script:ObservedUnlink=$true
        }
        Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters
    }
    Clear-NestedCheckout $Source
    Remove-Item Function:Remove-Item
    if ($Cycle -eq 1 -and -not $script:ObservedUnlink) { throw 'workspace-unlink-not-observed' }
    if ($Cycle -eq 1) { $script:ObservedUnlink=$false }
}
@{kept=(Test-OwnershipPreserved);children=@(Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {$_.Name});unlinkObserved=$script:ObservedUnlink}|ConvertTo-Json -Compress
`,
            expected: { kept: true, children: [".ccc-nested-checkout"], unlinkObserved: true },
        },
        {
            name: "clears junctions while the stable root is the process working directory",
            windowsOnly: true,
            body: `
New-WorkspaceFixture
Add-AllWorkspaceLinks
$PreviousDirectory=[Environment]::CurrentDirectory
[Environment]::CurrentDirectory=$Source
try {
    Rename-Item -LiteralPath $Marker -NewName '.CCC-NESTED-CHECKOUT' -Force
    Clear-NestedCheckout $Source
    @{kept=(Test-OwnershipPreserved);children=@(Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {$_.Name})}|ConvertTo-Json -Compress
} finally { [Environment]::CurrentDirectory=$PreviousDirectory }
`,
            expected: { kept: true, children: [".CCC-NESTED-CHECKOUT"] },
        },
        ...(["root", "marker", "nested"] as const).map(kind => ({
            name: `rejects a ${kind} redirect without touching its target`,
            body: `
$Outside=Join-Path $Fixture 'outside'
[IO.Directory]::CreateDirectory($Outside) | Out-Null
$Sentinel=Join-Path $Outside 'sentinel';Set-Content -LiteralPath $Sentinel -Value ('a'*32)
${kind === "root" ? "Remove-Item -LiteralPath $Source -Recurse -Force;$Link=$Source;$Target=$Outside" : kind === "marker" ? `Remove-Item -LiteralPath $Marker -Force;$Link=$Marker;$Target=${linkType === "Junction" ? "$Outside" : "$Sentinel"}` : "$Link=Join-Path $Source 'nested';$Target=$Outside"}
${createLink("$Link", "$Target")}
$Code=Invoke-RejectedCleanup
@{code=$Code;preserved=([IO.File]::ReadAllText($Sentinel)).Trim()}|ConvertTo-Json -Compress
`,
            expected: { code: kind === "nested" ? "nested-checkout-reparse-point" : "nested-checkout-not-owned", preserved: "a".repeat(32) },
        })),
        ...["hyper-v", "device-lab", "device-lab-mcp"].map(name => ({
            name: `rejects ${name} linked to the wrong ordinary workspace target`,
            body: rejection(`Add-WorkspaceLink '${name}' (Join-Path $Source '${name === "device-lab-mcp" ? "packages/hyper-v" : "device-lab-mcp"}')`),
            expected: rejected,
        })),
        {
            name: "rejects an exact known link pointing outside the checkout",
            body: rejection(`
$Outside=Join-Path $Fixture 'outside'
[IO.Directory]::CreateDirectory($Outside) | Out-Null
Set-Content -LiteralPath (Join-Path $Outside 'sentinel') -Value 'outside'
Add-WorkspaceLink 'hyper-v' $Outside
`, "(Test-SourcePreserved) -and (([IO.File]::ReadAllText((Join-Path $Outside 'sentinel'))).Trim() -eq 'outside')"),
            expected: rejected,
        },
        ...(["missing", "file"] as const).map(kind => ({
            name: `rejects a known link whose canonical target is ${kind}`,
            body: rejection(`
$Target=Join-Path $Source 'packages/hyper-v'
Add-WorkspaceLink 'hyper-v' $Target
Remove-Item -LiteralPath $Target -Recurse -Force
${kind === "file" ? "Set-Content -LiteralPath $Target -Value 'ordinary file'" : ""}
`),
            expected: rejected,
        })),
        {
            name: "rejects a known link whose canonical target is another link",
            body: rejection(`
$Target=Join-Path $Source 'packages/hyper-v'
Add-WorkspaceLink 'hyper-v' $Target
$Outside=Join-Path $Fixture 'outside'
Move-Item -LiteralPath $Target -Destination $Outside
${createLink("$Target", "$Outside")}
`, "(Test-SourcePreserved) -and (([IO.File]::ReadAllText((Join-Path $Outside 'workspace-sentinel'))).Trim() -eq 'hyper-v')"),
            expected: rejected,
        },
        {
            name: "rejects a redirected target ancestor without reading through it",
            body: rejection(`
Add-AllWorkspaceLinks
$Packages=Join-Path $Source 'packages'
$Outside=Join-Path $Fixture 'outside-packages'
Move-Item -LiteralPath $Packages -Destination $Outside
${createLink("$Packages", "$Outside")}
`, "(Test-SourcePreserved) -and (([IO.File]::ReadAllText((Join-Path $Outside 'hyper-v/workspace-sentinel'))).Trim() -eq 'hyper-v')"),
            expected: rejected,
        },
        {
            name: "rejects a redirected link ancestor",
            body: rejection(`
$Scope=Join-Path $Source 'node_modules/@ccc'
$Outside=Join-Path $Fixture 'outside-scope'
Move-Item -LiteralPath $Scope -Destination $Outside
${createLink("$Scope", "$Outside")}
`, "(Test-SourcePreserved) -and (Test-Path -LiteralPath $Outside -PathType Container)"),
            expected: rejected,
        },
        {
            name: "rejects a link inside a canonical workspace before unlinking any approved link",
            body: rejection(`
Add-AllWorkspaceLinks
$Outside=Join-Path $Fixture 'outside'
[IO.Directory]::CreateDirectory($Outside) | Out-Null
Set-Content -LiteralPath (Join-Path $Outside 'sentinel') -Value 'outside'
$Unexpected=Join-Path $Source 'packages/hyper-v/content'
${createLink("$Unexpected", "$Outside")}
`, "(Test-SourcePreserved) -and (@(Get-ChildItem -LiteralPath (Join-Path $Source 'node_modules/@ccc') -Force).Count -eq 3) -and (([IO.File]::ReadAllText((Join-Path $Outside 'sentinel'))).Trim() -eq 'outside')"),
            expected: rejected,
        },
        {
            name: "rejects a late unknown workspace link without deleting earlier approved links or contents",
            body: `
New-WorkspaceFixture
Add-AllWorkspaceLinks
$Scope=Join-Path $Source 'node_modules/@ccc'
$Unexpected=Join-Path $Source 'node_modules/@ccc/zzz-unknown'
${createLink("$Unexpected", "(Join-Path $Source 'packages/hyper-v')")}
function Get-ChildItem {
    [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
    $Actual=@(Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters)
    if ($LiteralPath -eq $Scope) {
        # The production scan uses a stack: push the unknown link first so all
        # approved links are inspected before this deliberately late rejection.
        $Actual | Sort-Object -Property @{Expression={if ($_.Name -eq 'zzz-unknown') {0} else {1}}},Name
    } else { $Actual }
}
$script:ApprovedSeen=0
$script:ApprovedBeforeUnknown=-1
function Get-Item {
    [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
    if ($LiteralPath -eq $Unexpected) { $script:ApprovedBeforeUnknown=$script:ApprovedSeen }
    elseif ($LiteralPath -eq (Join-Path $Scope 'hyper-v') -or $LiteralPath -eq (Join-Path $Scope 'device-lab') -or $LiteralPath -eq (Join-Path $Scope 'device-lab-mcp')) { $script:ApprovedSeen++ }
    Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters
}
$Code=Invoke-RejectedCleanup
@{code=$Code;kept=((Test-SourcePreserved) -and (@(Get-ChildItem -LiteralPath $Scope -Force).Count -eq 4) -and (([IO.File]::ReadAllText((Join-Path $Source 'packages/hyper-v/workspace-sentinel'))).Trim() -eq 'hyper-v'));approvedBeforeUnknown=$script:ApprovedBeforeUnknown}|ConvertTo-Json -Compress
`,
            expected: { ...rejected, approvedBeforeUnknown: 3 },
        },
        {
            name: "rejects a file symbolic link at an approved directory-link path",
            windowsOnly: true,
            requiresSymbolicLink: true,
            body: rejection(`
$Target=Join-Path $Source 'packages/hyper-v'
Remove-Item -LiteralPath $Target -Recurse -Force
Set-Content -LiteralPath $Target -Value 'temporary file target'
$Link=Join-Path $Source 'node_modules/@ccc/hyper-v'
New-Item -ItemType SymbolicLink -Path $Link -Target $Target | Out-Null
Remove-Item -LiteralPath $Target -Force
[IO.Directory]::CreateDirectory($Target) | Out-Null
Set-Content -LiteralPath (Join-Path $Target 'workspace-sentinel') -Value 'hyper-v'
`, "(Test-SourcePreserved) -and (([IO.File]::ReadAllText((Join-Path $Source 'packages/hyper-v/workspace-sentinel'))).Trim() -eq 'hyper-v')"),
            expected: rejected,
        },
        {
            name: "rejects replacement of an approved link at the fresh validation boundary",
            body: `
New-WorkspaceFixture
Add-WorkspaceLink 'hyper-v' (Join-Path $Source 'packages/hyper-v')
$Link=Join-Path $Source 'node_modules/@ccc/hyper-v'
$script:LinkLookups=0
function Get-Item {
    [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
    if ($LiteralPath -eq $Link) {
        $script:LinkLookups++
        if ($script:LinkLookups -eq 2) {
            [IO.Directory]::Delete($Link,$false)
            [IO.Directory]::CreateDirectory($Link) | Out-Null
            Set-Content -LiteralPath (Join-Path $Link 'replacement-sentinel') -Value 'replacement'
        }
    }
    Microsoft.PowerShell.Management\\Get-Item @PSBoundParameters
}
$Code=Invoke-RejectedCleanup
@{code=$Code;kept=(Test-SourcePreserved);replacement=(Test-Path -LiteralPath (Join-Path $Link 'replacement-sentinel'))}|ConvertTo-Json -Compress
`,
            expected: { ...rejected, replacement: true },
        },
        {
            name: "propagates a native junction unlink sharing failure without deleting its target",
            windowsOnly: true,
            body: `
New-WorkspaceFixture
Add-WorkspaceLink 'hyper-v' (Join-Path $Source 'packages/hyper-v')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NestedCheckoutLinkHandle {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool RemoveDirectoryW(string path);
}
'@
$Link=Join-Path $Source 'node_modules/@ccc/hyper-v'
$Handle=[NestedCheckoutLinkHandle]::CreateFileW($Link,0x10000,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
if ($Handle -eq [IntPtr]::Zero -or $Handle -eq [IntPtr](-1)) { throw 'fixture-junction-open-failed' }
try {
    $Failure=$null;try { Clear-NestedCheckout $Source } catch { $Failure=$_ }
    @{sharingViolation=($null -ne $Failure -and $Failure.Exception -is [Management.Automation.MethodInvocationException] -and ($Failure.Exception.InnerException.HResult -band 0xffff) -eq 32);kept=(Test-SourcePreserved);target=([IO.File]::ReadAllText((Join-Path $Source 'packages/hyper-v/workspace-sentinel'))).Trim()}|ConvertTo-Json -Compress
} finally {
    [NestedCheckoutLinkHandle]::CloseHandle($Handle) | Out-Null
    # Framework Directory.Delete may already remove junction metadata before the
    # native sharing failure. Remove this fixture link directly after releasing it.
    if (Test-Path -LiteralPath $Link) {
        if (-not [NestedCheckoutLinkHandle]::RemoveDirectoryW($Link)) { throw 'fixture-junction-release-failed' }
    }
}
`,
            expected: { sharingViolation: true, kept: true, target: "hyper-v" },
        },
    ];
}
