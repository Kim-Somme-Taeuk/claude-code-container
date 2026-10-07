$ErrorActionPreference = 'Stop'
$Documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
if ([string]::IsNullOrWhiteSpace($Documents)) {
    throw 'CurrentUser documents directory is unavailable'
}
$ModuleRoot = Join-Path $Documents 'WindowsPowerShell\Modules'
$AnalyzerManifest = Join-Path $ModuleRoot 'PSScriptAnalyzer\1.24.0\PSScriptAnalyzer.psd1'
$PesterManifest = Join-Path $ModuleRoot 'Pester\5.7.1\Pester.psd1'
foreach ($Manifest in @($AnalyzerManifest, $PesterManifest)) {
    if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
        throw "Pinned Hyper-V test module manifest is missing: $Manifest"
    }
}

Import-Module -Name $AnalyzerManifest -Force -ErrorAction Stop
if ((Get-Module PSScriptAnalyzer).Version -ne [Version]'1.24.0') { throw 'Unexpected PSScriptAnalyzer version' }
$AnalyzerFindings = @(Invoke-ScriptAnalyzer -Path $PSScriptRoot -Recurse -Severity Error)
if ($AnalyzerFindings.Count -gt 0) {
    $AnalyzerFindings | Format-Table -AutoSize | Out-String | Write-Error
    exit 1
}

Import-Module -Name $PesterManifest -Force -ErrorAction Stop
if ((Get-Module Pester).Version -ne [Version]'5.7.1') { throw 'Unexpected Pester version' }
$Result = Invoke-Pester -Path (Join-Path $PSScriptRoot 'tests') -PassThru
if ($Result.FailedCount -gt 0) { exit 1 }
