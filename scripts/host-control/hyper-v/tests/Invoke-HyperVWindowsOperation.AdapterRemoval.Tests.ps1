BeforeAll {
    $OperationSource = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'Invoke-HyperVWindowsOperation.ps1') -Raw
    $Branch = [regex]::Match($OperationSource, '(?ms)^        "Remove-VMNetworkAdapter" \{\r?\n(?<body>.*?)^        \}\r?\n        "Get-NetNeighbor" \{')
    if (-not $Branch.Success) { throw 'adapter-removal-branch-missing' }
    $script:AdapterRemovalBranch = [scriptblock]::Create($Branch.Groups['body'].Value)

    $FakeHyperV = New-Module -Name 'Hyper-V' -ScriptBlock {
        function Get-VMNetworkAdapter {
            [CmdletBinding()]
            param([object]$VM)
            return [pscustomobject]@{
                Name = 'CCC Bootstrap DHCP'
                MacAddress = '06155D011A2C'
            }
        }
        function Remove-VMNetworkAdapter {
            [CmdletBinding()]
            param([object]$VMNetworkAdapter, [switch]$Confirm)
            $global:AdapterRemovalCount += 1
        }
        Export-ModuleMember -Function Get-VMNetworkAdapter, Remove-VMNetworkAdapter
    }
    Import-Module $FakeHyperV -Force

    function Assert-HyperVWindowsSingleVirtualMachine([object[]]$VirtualMachines) {
        if ($VirtualMachines.Count -eq 0) { throw 'virtual-machine-not-found' }
        if ($VirtualMachines.Count -ne 1) { throw 'virtual-machine-selector-ambiguous' }
        return $VirtualMachines[0]
    }
    function Get-HyperVWindowsVirtualMachines([object]$Selector) {
        return @([pscustomobject]@{
            Id = [Guid][string]$Selector.id
            Notes = [string]$global:CurrentVmNotes
        })
    }
    function Write-HyperVWindowsSuccess([string]$Operation, [object[]]$Items) {
        return [pscustomobject]@{ operation = $Operation; items = $Items }
    }
    function Invoke-FakeAdapterRemoval([string]$ExpectedNotes = 'ccc-owner') {
        $Operation = 'Remove-VMNetworkAdapter'
        $Request = [pscustomobject]@{
            selector = [pscustomobject]@{ kind = 'id'; id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
            adapterName = 'CCC Bootstrap DHCP'
            macAddress = '06:15:5d:01:1a:2c'
            expectedNotes = $ExpectedNotes
        }
        $VirtualMachines = @(Get-HyperVWindowsVirtualMachines $Request.selector)
        & $script:AdapterRemovalBranch
    }
}

Describe 'typed Hyper-V adapter removal ownership fence' {
    BeforeEach {
        $global:CurrentVmNotes = 'ccc-owner'
        $global:AdapterRemovalCount = 0
    }

    It 'removes the exact adapter after rechecking the current ownership marker' {
        $Result = Invoke-FakeAdapterRemoval
        $Result.operation | Should -Be 'Remove-VMNetworkAdapter'
        $global:AdapterRemovalCount | Should -Be 1
    }

    It 'refuses when the ownership marker changes before the mutation' {
        $global:CurrentVmNotes = 'another-incarnation'
        { Invoke-FakeAdapterRemoval } | Should -Throw 'vm-network-adapter-identity-mismatch'
        $global:AdapterRemovalCount | Should -Be 0
    }

    It 'refuses an empty expected ownership marker' {
        { Invoke-FakeAdapterRemoval -ExpectedNotes '' } | Should -Throw 'vm-network-adapter-identity-mismatch'
        $global:AdapterRemovalCount | Should -Be 0
    }

    AfterAll {
        Remove-Module 'Hyper-V' -ErrorAction SilentlyContinue
        Remove-Variable -Scope Global -Name CurrentVmNotes, AdapterRemovalCount -ErrorAction SilentlyContinue
    }
}
