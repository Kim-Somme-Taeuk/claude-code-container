param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$SourceSha,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$NodeVersion,
    [ValidateSet('linux','windows')][string]$Target = 'windows'
)
$ErrorActionPreference = 'Stop'
$Root = 'C:\ccc-nested-development'
$Run = Join-Path $Root $RunId
$Stage = 'bootstrap'
$Outcome = @{status='FAIL';stage=$Stage;runId=$RunId}
$TranscriptStarted = $false
function Write-JobProgress([string]$CurrentStage) {
    # Same-volume replacement leaves readers either the previous complete record or the next.
    $PendingProgress = Join-Path $Run 'progress.pending.json'
    @{kind='progress';runId=$RunId;stage=$CurrentStage} | ConvertTo-Json -Compress | Set-Content -LiteralPath $PendingProgress -Encoding UTF8
    $ProgressPath = Join-Path $Run 'progress.json'
    # Windows PowerShell 5.1 binds $null to an empty string for this string argument.
    # NullString supplies the actual null backup path required by File.Replace.
    if (Test-Path -LiteralPath $ProgressPath) { [IO.File]::Replace($PendingProgress, $ProgressPath, [NullString]::Value) }
    else { [IO.File]::Move($PendingProgress, $ProgressPath) }
}
function Clear-NestedCheckout([string]$Source) {
    # A live child may retain this directory as its cwd. Keep the stable root and
    # ownership marker even if clearing a locked child fails, so retry stays safe.
    $Directory = Get-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
    $MarkerPath = Join-Path $Source '.ccc-nested-checkout'
    if ($null -eq $Directory -or $Directory -isnot [IO.DirectoryInfo] -or ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'nested-checkout-not-owned' }
    $Marker = Get-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $Marker -or $Marker -isnot [IO.FileInfo] -or ($Marker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Marker.Length -gt 128 -or ([IO.File]::ReadAllText($MarkerPath)).Trim() -notmatch '^[a-f0-9]{32}$') { throw 'nested-checkout-not-owned' }
    $Source = [IO.Path]::GetFullPath($Directory.FullName)
    $MarkerPath = Join-Path $Source '.ccc-nested-checkout'
    $MarkerIdentity = ([IO.File]::ReadAllText($MarkerPath)).Trim()
    if ($MarkerIdentity -notmatch '^[a-f0-9]{32}$') { throw 'nested-checkout-not-owned' }
    $PathComparer = [StringComparer]::Ordinal
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $PathComparer = [StringComparer]::OrdinalIgnoreCase }
    $WorkspaceTargets = [Collections.Generic.Dictionary[string,string]]::new($PathComparer)
    $WorkspaceTargets.Add((Join-Path $Source 'node_modules/@ccc/hyper-v'), (Join-Path $Source 'packages/hyper-v'))
    $WorkspaceTargets.Add((Join-Path $Source 'node_modules/@ccc/device-lab'), (Join-Path $Source 'packages/device-lab'))
    $WorkspaceTargets.Add((Join-Path $Source 'node_modules/@ccc/device-lab-mcp'), (Join-Path $Source 'device-lab-mcp'))
    function Assert-NestedCheckoutOwnership {
        $CurrentRoot = Get-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
        if ($null -eq $CurrentRoot -or $CurrentRoot -isnot [IO.DirectoryInfo] -or ($CurrentRoot.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'nested-checkout-not-owned' }
        $CurrentMarker = Get-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
        if ($null -eq $CurrentMarker -or $CurrentMarker -isnot [IO.FileInfo] -or ($CurrentMarker.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $CurrentMarker.Length -gt 128 -or ([IO.File]::ReadAllText($MarkerPath)).Trim() -ne $MarkerIdentity) { throw 'nested-checkout-not-owned' }
    }
    function Get-NestedWorkspaceTarget([IO.FileSystemInfo]$Item) {
        $ExpectedTarget = $null
        if (-not $WorkspaceTargets.TryGetValue($Item.FullName, [ref]$ExpectedTarget) -or $Item -isnot [IO.DirectoryInfo] -or -not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.LinkType -notin @('Junction', 'SymbolicLink')) { throw 'nested-checkout-reparse-point' }
        $Targets = @($Item.Target)
        if ($Targets.Count -ne 1 -or $Targets[0] -isnot [string] -or [string]::IsNullOrWhiteSpace($Targets[0])) { throw 'nested-checkout-reparse-point' }
        $ActualTarget = $Targets[0]
        if (-not [IO.Path]::IsPathRooted($ActualTarget)) { $ActualTarget = Join-Path ([IO.Path]::GetDirectoryName($Item.FullName)) $ActualTarget }
        if (-not $PathComparer.Equals([IO.Path]::GetFullPath($ActualTarget), $ExpectedTarget)) { throw 'nested-checkout-reparse-point' }
        return $ExpectedTarget
    }
    function Assert-NestedOrdinaryDirectory([string]$Path) {
        # Check each ancestor before looking beneath it, never through a link.
        $CurrentPath = $Source
        foreach ($Part in $Path.Substring($Source.Length).TrimStart([char[]]'\/').Split([char[]]'\/', [StringSplitOptions]::RemoveEmptyEntries)) {
            $CurrentPath = Join-Path $CurrentPath $Part
            $Current = Get-Item -LiteralPath $CurrentPath -Force -ErrorAction SilentlyContinue
            if ($null -eq $Current -or $Current -isnot [IO.DirectoryInfo] -or ($Current.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'nested-checkout-reparse-point' }
        }
    }
    function Get-NestedCheckoutTree([bool]$AllowWorkspaceLinks) {
        Assert-NestedCheckoutOwnership
        $Children = @(Get-ChildItem -LiteralPath $Source -Force | Where-Object { $_.Name -ne '.ccc-nested-checkout' })
        $Pending = [Collections.Generic.Stack[string]]::new()
        $OrdinaryDirectories = [Collections.Generic.HashSet[string]]::new($PathComparer)
        $Links = [Collections.Generic.List[string]]::new()
        foreach ($Child in $Children) { $Pending.Push($Child.FullName) }
        # Complete this non-following scan before deleting even an approved link.
        while ($Pending.Count -gt 0) {
            $Item = Get-Item -LiteralPath $Pending.Pop() -Force
            if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                if (-not $AllowWorkspaceLinks) { throw 'nested-checkout-reparse-point' }
                $null = Get-NestedWorkspaceTarget $Item
                $Links.Add($Item.FullName)
            } elseif ($Item -is [IO.DirectoryInfo]) {
                $null = $OrdinaryDirectories.Add($Item.FullName)
                foreach ($Child in @(Get-ChildItem -LiteralPath $Item.FullName -Force)) { $Pending.Push($Child.FullName) }
            }
        }
        # Only ordinary directories reached without traversing a link can be targets.
        foreach ($Link in $Links) {
            if (-not $OrdinaryDirectories.Contains($WorkspaceTargets[$Link])) { throw 'nested-checkout-reparse-point' }
        }
        return @{Children=$Children.FullName; Links=$Links.ToArray()}
    }
    $Tree = Get-NestedCheckoutTree $true
    # Validate all candidates again before the first unlink, then at each mutation.
    foreach ($Link in $Tree.Links) {
        Assert-NestedCheckoutOwnership
        Assert-NestedOrdinaryDirectory ([IO.Path]::GetDirectoryName($Link))
        $ExpectedTarget = Get-NestedWorkspaceTarget (Get-Item -LiteralPath $Link -Force)
        Assert-NestedOrdinaryDirectory $ExpectedTarget
    }
    foreach ($Link in $Tree.Links) {
        Assert-NestedCheckoutOwnership
        Assert-NestedOrdinaryDirectory ([IO.Path]::GetDirectoryName($Link))
        $ExpectedTarget = Get-NestedWorkspaceTarget (Get-Item -LiteralPath $Link -Force)
        Assert-NestedOrdinaryDirectory $ExpectedTarget
        # Delete the link itself, without recursively visiting its destination.
        [IO.Directory]::Delete($Link, $false)
    }
    # Refresh metadata and enumeration after unlinking; cached link objects are stale.
    $Tree = Get-NestedCheckoutTree $false
    foreach ($ChildPath in $Tree.Children) {
        Assert-NestedCheckoutOwnership
        $Child = Get-Item -LiteralPath $ChildPath -Force
        if ($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'nested-checkout-reparse-point' }
        Remove-Item -LiteralPath $ChildPath -Recurse -Force
    }
}
try {
    Write-JobProgress $Stage
    Start-Transcript -Path (Join-Path $Run 'job.log') -Force | Out-Null
    $TranscriptStarted = $true
    if (-not (Get-CimInstance Win32_ComputerSystem).HypervisorPresent) { throw 'nested-hypervisor-not-running' }
    # Image acquisition and disk copying check their destination volume using
    # actual byte requirements. Virtual disk capacity is not an upfront allocation.
    $NodeRoot = Join-Path $Run "node-v$NodeVersion-win-x64"
    if (-not (Test-Path (Join-Path $NodeRoot 'node.exe'))) {
        $Zip = Join-Path $Run 'node.zip'
        $Base = "https://nodejs.org/dist/v$NodeVersion"
        $File = "node-v$NodeVersion-win-x64.zip"
        Invoke-WebRequest "$Base/$File" -OutFile $Zip -UseBasicParsing
        $Sums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content
        $Match = [regex]::Match($Sums, ('(?m)^([a-f0-9]{64})  ' + [regex]::Escape($File) + '\r?$'))
        if (-not $Match.Success -or (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Match.Groups[1].Value) { throw 'nested-node-integrity-failed' }
        Expand-Archive -LiteralPath $Zip -DestinationPath $Run
    }
    $env:PATH = "$NodeRoot;" + $env:PATH
    $env:CCC_HYPER_V_NESTED_HOST = '1'
    $env:CCC_DEVICE_BROKER_AUTO_START = '0'
    if (Test-Path -LiteralPath (Join-Path $Run 'license.json')) {
        $Setup = Join-Path $env:USERPROFILE '.ccc\device-broker-private\setup'
        New-Item -ItemType Directory -Force -Path $Setup | Out-Null
        Copy-Item -LiteralPath (Join-Path $Run 'license.json') -Destination (Join-Path $Setup 'hyper-v-windows-evaluation-license.json') -Force
    }
    $Archive = Join-Path $Run 'source.tar.gz'
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $SourceSha) { throw 'nested-source-integrity-failed' }
    # Stable checkout path keeps broker owner identity stable across candidate runs.
    $Source = Join-Path $Root 'checkout'
    if (-not (Test-Path -LiteralPath $Source)) {
        New-Item -ItemType Directory -Path $Source | Out-Null
        Set-Content -LiteralPath (Join-Path $Source '.ccc-nested-checkout') -Value $RunId -Encoding ASCII
    }
    Clear-NestedCheckout $Source
    Set-Content -LiteralPath (Join-Path $Source '.ccc-nested-checkout') -Value $RunId -Encoding ASCII
    & tar.exe -xzf $Archive -C $Source
    if ($LASTEXITCODE -ne 0) { throw 'nested-source-extract-failed' }
    Set-Location $Source
    $Stage = 'install'
    Write-JobProgress $Stage
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'nested-npm-ci-failed' }
    $Stage = 'build'
    Write-JobProgress $Stage
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'nested-build-failed' }
    $Stage = 'test'
    Write-JobProgress $Stage
    & node.exe --import tsx scripts/real-tests/nested-hyper-v-guest.ts $Target
    if ($LASTEXITCODE -ne 0) { throw 'nested-tests-failed' }
    $Stage = 'cleanup'
    Write-JobProgress $Stage
    Set-Location $Run
    Clear-NestedCheckout $Source
    Remove-Item -LiteralPath $Archive -Force
    $Outcome = @{status='PASS';stage='complete';runId=$RunId;sourceSha256=$SourceSha}
} catch { $Outcome = @{status='FAIL';stage=$Stage;runId=$RunId;sourceSha256=$SourceSha;error=$_.Exception.Message} }
finally {
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
    $Pending = Join-Path $Run 'result.pending.json'
    $Outcome | ConvertTo-Json -Compress | Set-Content -LiteralPath $Pending -Encoding UTF8
    Move-Item -LiteralPath $Pending -Destination (Join-Path $Run 'result.json')
}
