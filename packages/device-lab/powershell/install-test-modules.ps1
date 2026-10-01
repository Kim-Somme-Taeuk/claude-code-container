[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
if ([string]::IsNullOrWhiteSpace($Documents)) {
    throw 'CurrentUser documents directory is unavailable'
}
$CurrentUserModuleRoot = Join-Path $Documents 'WindowsPowerShell\Modules'

$Requirements = @(
    @{
        Name = 'Pester'
        Version = '5.7.1'
        Sha256 = '4a27904c6814a5fbe4758f8e49861f6a1994aee77b71165a5c43c0371ba6c580'
    },
    @{
        Name = 'PSScriptAnalyzer'
        Version = '1.24.0'
        Sha256 = 'e86c97d44bb1bc8a1de35e753b85ea1d938f6f9f881639a181507e079bca4556'
    }
)

function Import-ExactModule {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Version,
        [string]$ManifestPath
    )

    Remove-Module -Name $Name -Force -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        Import-Module -Name $Name -RequiredVersion $Version -Force -ErrorAction Stop
    } else {
        Import-Module -Name $ManifestPath -Force -ErrorAction Stop
    }
    $Loaded = @(Get-Module -Name $Name | Where-Object {
        $_.Version -eq [Version]$Version
    })
    if ($Loaded.Count -ne 1) {
        throw "Unexpected $Name version"
    }
}

function Assert-SafeDirectoryBoundary {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not ($Root -is [IO.DirectoryInfo])) {
        throw "Expected module directory: $Path"
    }
    if (($Root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing module reparse point: $Path"
    }
}

function Assert-SafeDirectoryTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    Assert-SafeDirectoryBoundary -Path $Path
    $Root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    foreach ($Child in $Root.EnumerateFileSystemInfos()) {
        if (($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing module tree reparse point: $($Child.FullName)"
        }
        if ($Child -is [IO.DirectoryInfo]) {
            Assert-SafeDirectoryTree -Path $Child.FullName
        }
    }
}

function Remove-SafeDirectoryTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    Assert-SafeDirectoryTree -Path $Path
    $Root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    foreach ($Child in $Root.EnumerateFileSystemInfos()) {
        if ($Child -is [IO.DirectoryInfo]) {
            Remove-SafeDirectoryTree -Path $Child.FullName
        } else {
            if (($Child.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
                $Child.Attributes = $Child.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
            }
            $Child.Delete()
        }
    }
    $Root.Delete()
}

function Get-PackageSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Stream = [IO.File]::OpenRead($Path)
    try {
        $Hasher = [Security.Cryptography.SHA256]::Create()
        try {
            return [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $Hasher.Dispose()
        }
    } finally {
        $Stream.Dispose()
    }
}

function Expand-TrustedModulePackage {
    param(
        [Parameter(Mandatory = $true)][string]$PackagePath,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $DestinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    $Archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
    try {
        foreach ($Entry in $Archive.Entries) {
            $RelativePath = $Entry.FullName.Replace(
                [IO.Path]::AltDirectorySeparatorChar,
                [IO.Path]::DirectorySeparatorChar
            )
            $DestinationPath = [IO.Path]::GetFullPath((Join-Path $Destination $RelativePath))
            if (-not $DestinationPath.StartsWith($DestinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Unsafe module package entry: $($Entry.FullName)"
            }
            if ([string]::IsNullOrEmpty($Entry.Name)) {
                New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
                continue
            }
            $Parent = Split-Path -Parent $DestinationPath
            New-Item -ItemType Directory -Path $Parent -Force | Out-Null
            $Source = $Entry.Open()
            try {
                $Target = [IO.File]::Open(
                    $DestinationPath,
                    [IO.FileMode]::CreateNew,
                    [IO.FileAccess]::Write,
                    [IO.FileShare]::None
                )
                try {
                    $Source.CopyTo($Target)
                } finally {
                    $Target.Dispose()
                }
            } finally {
                $Source.Dispose()
            }
        }
    } finally {
        $Archive.Dispose()
    }
}

function Install-PinnedModule {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Requirement
    )

    New-Item -ItemType Directory -Path $CurrentUserModuleRoot -Force | Out-Null
    Assert-SafeDirectoryBoundary -Path $CurrentUserModuleRoot
    $ModuleParent = Join-Path $CurrentUserModuleRoot $Requirement.Name
    New-Item -ItemType Directory -Path $ModuleParent -Force | Out-Null
    Assert-SafeDirectoryBoundary -Path $ModuleParent
    $Destination = Join-Path $ModuleParent $Requirement.Version
    $InstalledManifest = Join-Path $Destination "$($Requirement.Name).psd1"
    $InstallMarker = Join-Path $Destination '.ccc-package.sha256'
    if (Test-Path -LiteralPath $Destination) {
        Assert-SafeDirectoryTree -Path $Destination
        $MarkerMatches = (Test-Path -LiteralPath $InstallMarker -PathType Leaf) -and
            ((Get-Content -LiteralPath $InstallMarker -Raw -ErrorAction Stop).Trim() -eq $Requirement.Sha256)
        if ($MarkerMatches) {
            try {
                Import-ExactModule -Name $Requirement.Name -Version $Requirement.Version `
                    -ManifestPath $InstalledManifest
                Write-Host "READY $($Requirement.Name) $($Requirement.Version)"
                return
            } catch {
                Remove-Module -Name $Requirement.Name -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $Nonce = [Guid]::NewGuid().ToString('N')
    $Staging = Join-Path $ModuleParent (".$($Requirement.Version).$Nonce.tmp")
    $Backup = Join-Path $ModuleParent (".$($Requirement.Version).$Nonce.backup")
    $PackagePath = Join-Path ([IO.Path]::GetTempPath()) ("ccc-$($Requirement.Name)-$Nonce.nupkg")
    $PackageUri = "https://www.powershellgallery.com/api/v2/package/$($Requirement.Name)/$($Requirement.Version)"

    New-Item -ItemType Directory -Path $Staging -Force | Out-Null
    Assert-SafeDirectoryTree -Path $Staging
    $BackupPresent = $false
    $Published = $false
    $Committed = $false
    try {
        Invoke-WebRequest -Uri $PackageUri -UseBasicParsing -OutFile $PackagePath -ErrorAction Stop
        $ActualHash = Get-PackageSha256 -Path $PackagePath
        if ($ActualHash -ne $Requirement.Sha256) {
            throw "Unexpected $($Requirement.Name) package SHA-256"
        }

        Expand-TrustedModulePackage -PackagePath $PackagePath -Destination $Staging
        $StagedManifest = Join-Path $Staging "$($Requirement.Name).psd1"
        $Manifest = Test-ModuleManifest -Path $StagedManifest -ErrorAction Stop
        if ($Manifest.Name -cne $Requirement.Name -or $Manifest.Version -ne [Version]$Requirement.Version) {
            throw "Unexpected $($Requirement.Name) package manifest"
        }
        Set-Content -LiteralPath (Join-Path $Staging '.ccc-package.sha256') `
            -Value $Requirement.Sha256 -Encoding Ascii -NoNewline -ErrorAction Stop

        if (Test-Path -LiteralPath $Destination) {
            Assert-SafeDirectoryTree -Path $Destination
            Move-Item -LiteralPath $Destination -Destination $Backup -ErrorAction Stop
            $BackupPresent = $true
        }
        Move-Item -LiteralPath $Staging -Destination $Destination -ErrorAction Stop
        $Published = $true
        Import-ExactModule -Name $Requirement.Name -Version $Requirement.Version `
            -ManifestPath $InstalledManifest
        $Committed = $true
    } catch {
        $InstallError = $_
        Remove-Module -Name $Requirement.Name -Force -ErrorAction SilentlyContinue
        try {
            if (-not $Committed -and $Published -and (Test-Path -LiteralPath $Destination)) {
                Remove-SafeDirectoryTree -Path $Destination
                $Published = $false
            }
            if (-not $Committed -and $BackupPresent) {
                if (Test-Path -LiteralPath $Destination) {
                    throw "Cannot restore $($Requirement.Name): destination is occupied"
                }
                Move-Item -LiteralPath $Backup -Destination $Destination -ErrorAction Stop
                $BackupPresent = $false
            }
        } catch {
            throw "Failed to install $($Requirement.Name) and restore its previous version: $($_.Exception.Message); install error: $($InstallError.Exception.Message)"
        }
        throw $InstallError
    } finally {
        if (Test-Path -LiteralPath $PackagePath) {
            Remove-Item -LiteralPath $PackagePath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $Staging) {
            Remove-SafeDirectoryTree -Path $Staging
        }
    }
    if ($BackupPresent) {
        try {
            Remove-SafeDirectoryTree -Path $Backup
        } catch {
            Write-Warning "Installed $($Requirement.Name), but its retired backup remains at $Backup"
        }
        $BackupPresent = $false
    }
    Write-Host "READY $($Requirement.Name) $($Requirement.Version)"
}

foreach ($Requirement in $Requirements) {
    Install-PinnedModule -Requirement $Requirement
}
