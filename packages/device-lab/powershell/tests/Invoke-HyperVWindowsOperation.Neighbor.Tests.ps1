BeforeAll {
    $OperationSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../hyper-v/powershell/Invoke-HyperVWindowsOperation.ps1') -Raw
    $Branch = [regex]::Match($OperationSource, '(?ms)^        "Get-NetNeighbor" \{\r?\n(?<body>.*?)^        \}\r?\n        "Get-NetAdapter" \{')
    if (-not $Branch.Success) { throw 'neighbor-branch-missing' }
    $script:NeighborBranch = [scriptblock]::Create($Branch.Groups['body'].Value)

    $FakeNetTCPIP = New-Module -Name 'NetTCPIP' -ScriptBlock {
        function Get-NetNeighbor {
            [CmdletBinding()]
            param([string]$AddressFamily, [uint32]$InterfaceIndex)
            $global:NeighborReadRequests += [pscustomobject]@{
                addressFamily = $AddressFamily
                interfaceIndex = $InterfaceIndex
            }
            if ($global:NeighborReadMode -eq 'empty') { return }
            if ($global:NeighborReadMode -in @('no-match', 'wrong-category', 'wrong-id', 'missing-interface')) {
                $record = [Management.Automation.ErrorRecord]::new(
                    [Exception]::new('no matching rows'),
                    $(if ($global:NeighborReadMode -eq 'wrong-id') {
                        'InterfaceGone'
                    } elseif ($global:NeighborReadMode -eq 'missing-interface') {
                        'CmdletizationQuery_NotFound_InterfaceIndex'
                    } else {
                        'CmdletizationQuery_NotFound'
                    }),
                    $(if ($global:NeighborReadMode -eq 'wrong-category') {
                        [Management.Automation.ErrorCategory]::InvalidOperation
                    } else {
                        [Management.Automation.ErrorCategory]::ObjectNotFound
                    }),
                    $null
                )
                $PSCmdlet.WriteError($record)
                return
            }
            if ($global:NeighborReadMode -eq 'failure') {
                $record = [Management.Automation.ErrorRecord]::new(
                    [Exception]::new('provider failed'),
                    'ProviderReadFailed',
                    [Management.Automation.ErrorCategory]::InvalidOperation,
                    $null
                )
                $PSCmdlet.WriteError($record)
                return
            }
            return [pscustomobject]@{
                InterfaceIndex = $InterfaceIndex
                IPAddress = '172.20.0.9'
                LinkLayerAddress = '06-15-5D-01-1A-2C'
                State = 'Reachable'
            }
        }
        Export-ModuleMember -Function Get-NetNeighbor
    }
    Import-Module $FakeNetTCPIP -Force

    function Write-HyperVWindowsSuccess([string]$Operation, [object[]]$Items) {
        return [pscustomobject]@{ operation = $Operation; items = $Items }
    }
    function Invoke-FakeNeighborRead {
        $Operation = 'Get-NetNeighbor'
        $Request = [pscustomobject]@{ interfaceIndex = 42 }
        & $script:NeighborBranch
    }
}

Describe 'typed Hyper-V neighbor read' {
    BeforeEach {
        $global:NeighborReadMode = 'rows'
        $global:NeighborReadRequests = @()
    }

    It 'keeps an interface-scoped successful row' {
        $result = Invoke-FakeNeighborRead
        @($result.items).Count | Should -Be 1
        $result.items[0].address | Should -Be '172.20.0.9'
        $result.items[0].state | Should -Be 'Reachable'
        $global:NeighborReadRequests.Count | Should -Be 1
        $global:NeighborReadRequests[0].addressFamily | Should -Be 'IPv4'
        $global:NeighborReadRequests[0].interfaceIndex | Should -Be 42
    }

    It 'treats only the exact no-match error as an empty table' {
        $global:NeighborReadMode = 'no-match'
        $result = Invoke-FakeNeighborRead
        @($result.items).Count | Should -Be 0
    }

    It 'accepts a successful query with no rows' {
        $global:NeighborReadMode = 'empty'
        $result = Invoke-FakeNeighborRead
        @($result.items).Count | Should -Be 0
    }

    It 'fails when the neighbor provider reports a different nonterminating error' {
        $global:NeighborReadMode = 'failure'
        { Invoke-FakeNeighborRead } | Should -Throw 'net-neighbor-inspection-failed'
    }

    It 'does not accept a no-match identity with the wrong error category' {
        $global:NeighborReadMode = 'wrong-category'
        { Invoke-FakeNeighborRead } | Should -Throw 'net-neighbor-inspection-failed'
    }

    It 'does not accept ObjectNotFound with a different error identity' {
        $global:NeighborReadMode = 'wrong-id'
        { Invoke-FakeNeighborRead } | Should -Throw 'net-neighbor-inspection-failed'
    }

    It 'does not treat a disappeared interface as an empty neighbor table' {
        $global:NeighborReadMode = 'missing-interface'
        { Invoke-FakeNeighborRead } | Should -Throw 'net-neighbor-inspection-failed'
    }

    AfterAll {
        Remove-Module 'NetTCPIP' -ErrorAction SilentlyContinue
        Remove-Variable -Scope Global -Name NeighborReadMode, NeighborReadRequests -ErrorAction SilentlyContinue
    }
}
