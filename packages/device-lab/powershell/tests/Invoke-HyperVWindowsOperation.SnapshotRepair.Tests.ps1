BeforeAll {
    $OperationSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../hyper-v/powershell/Invoke-HyperVWindowsOperation.ps1') -Raw
    $Branch = [regex]::Match($OperationSource, '(?ms)^        "Repair-VMSnapshotState" \{\r?\n(?<body>.*?)^        \}\r?\n        "Get-VMSwitch" \{')
    if (-not $Branch.Success) { throw 'snapshot-repair-branch-missing' }
    $script:RepairBranch = [scriptblock]::Create($Branch.Groups['body'].Value)
    $Guard = [regex]::Match($OperationSource, '(?ms)^function Assert-HyperVWindowsSnapshotRepairIdentity\(\[object\]\$Request\) \{.*?^\}\r?\n')
    if (-not $Guard.Success) { throw 'snapshot-repair-identity-guard-missing' }
    . ([scriptblock]::Create($Guard.Value))

    $FakeHyperV = New-Module -Name 'Hyper-V' -ScriptBlock {
        function Set-VM {
            [CmdletBinding()]
            param([object]$VM, [string]$CheckpointType)
            $global:RepairSetCalls += $CheckpointType
            if (@($global:RepairFailPolicy) -contains $CheckpointType) { throw 'fake-policy-write-failed' }
            $global:RepairVm.CheckpointType = $CheckpointType
        }
        function Get-VMSnapshot {
            [CmdletBinding()]
            param([object]$VM)
            return $global:RepairSnapshots
        }
        Export-ModuleMember -Function Set-VM, Get-VMSnapshot
    }
    Import-Module $FakeHyperV -Force

    function Get-HyperVWindowsVirtualMachines([object]$Selector) {
        $global:RepairOwnerReads++
        if ($global:RepairOwnerDriftAt -eq $global:RepairOwnerReads) { return @() }
        return @($global:RepairVm)
    }
    function Write-HyperVWindowsSuccess([string]$Operation, [object[]]$Items) {
        return [pscustomobject]@{ operation = $Operation; items = $Items }
    }
    function Invoke-FakeSnapshotRepair {
        $Operation = 'Repair-VMSnapshotState'
        $Request = [pscustomobject]@{
            schemaVersion = 1
            operation = $Operation
            selector = [pscustomobject]@{ kind = 'id'; id = '12345678-1234-1234-1234-123456789abc' }
            expectedName = 'owned-vm'
            expectedNotes = 'opaque-owner-marker'
            snapshotName = 'ccc-0123456789abcdef-baseline'
            expectedCheckpointPolicy = 'ProductionOnly'
        }
        & $script:RepairBranch
    }
}

Describe 'typed Hyper-V snapshot repair native transaction' {
    BeforeEach {
        $global:RepairVm = [pscustomobject]@{
            Id = '12345678-1234-1234-1234-123456789abc'
            Name = 'owned-vm'
            Notes = 'opaque-owner-marker'
            CheckpointType = 'Standard'
        }
        $global:RepairSnapshots = @([pscustomobject]@{ Name = 'CCC-0123456789ABCDEF-BASELINE' })
        $global:RepairSetCalls = @()
        $global:RepairFailPolicy = @()
        $global:RepairOwnerReads = 0
        $global:RepairOwnerDriftAt = -1
    }

    It 'restores the expected policy and counts a case variant of the exact snapshot name' {
        $Result = Invoke-FakeSnapshotRepair
        $Result.items[0].checkpointPolicy | Should -Be 'ProductionOnly'
        $Result.items[0].candidateCount | Should -Be 1
        ($global:RepairSetCalls -join ',') | Should -Be 'ProductionOnly'
    }

    It 'rejects ownership drift before any policy write' {
        $global:RepairOwnerDriftAt = 2
        { Invoke-FakeSnapshotRepair } | Should -Throw 'vm-identity-mismatch'
        $global:RepairSetCalls.Count | Should -Be 0
    }

    It 'refuses an already quarantined VM without a policy write' {
        $global:RepairVm.CheckpointType = 'Disabled'
        { Invoke-FakeSnapshotRepair } | Should -Throw 'hyper-v-snapshot-policy-quarantined'
        $global:RepairSetCalls.Count | Should -Be 0
    }

    It 'reports zero candidates after restoring policy when no checkpoint remains' {
        $global:RepairSnapshots = @()
        $Result = Invoke-FakeSnapshotRepair
        $Result.items[0].candidateCount | Should -Be 0
        ($global:RepairSetCalls -join ',') | Should -Be 'ProductionOnly'
    }

    It 'rejects wrong owner Notes before any policy write' {
        $global:RepairVm.Notes = 'foreign-owner'
        { Invoke-FakeSnapshotRepair } | Should -Throw 'vm-identity-mismatch'
        $global:RepairSetCalls.Count | Should -Be 0
    }

    It 'quarantines when policy restoration fails' {
        $global:RepairFailPolicy = 'ProductionOnly'
        { Invoke-FakeSnapshotRepair } | Should -Throw 'hyper-v-snapshot-policy-restore-failed'
        $global:RepairVm.CheckpointType | Should -Be 'Disabled'
        ($global:RepairSetCalls -join ',') | Should -Be 'ProductionOnly,Disabled'
    }

    It 'reports failed quarantine without claiming restored policy' {
        $global:RepairFailPolicy = @('ProductionOnly', 'Disabled')
        { Invoke-FakeSnapshotRepair } | Should -Throw 'hyper-v-snapshot-policy-quarantine-failed'
        $global:RepairVm.CheckpointType | Should -Be 'Standard'
    }

    It 'rejects duplicate exact-name candidates after policy restoration' {
        $global:RepairSnapshots = @(
            [pscustomobject]@{ Name = 'ccc-0123456789abcdef-baseline' },
            [pscustomobject]@{ Name = 'CCC-0123456789ABCDEF-BASELINE' }
        )
        { Invoke-FakeSnapshotRepair } | Should -Throw 'hyper-v-snapshot-reconciliation-ambiguous'
        ($global:RepairSetCalls -join ',') | Should -Be 'ProductionOnly'
    }

    AfterAll {
        Remove-Module 'Hyper-V' -ErrorAction SilentlyContinue
        Remove-Variable -Scope Global -Name RepairVm, RepairSnapshots, RepairSetCalls, RepairFailPolicy, RepairOwnerReads, RepairOwnerDriftAt -ErrorAction SilentlyContinue
    }
}
