BeforeAll {
    $Source = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'Invoke-HyperVWindowsOperation.ps1') -Raw
    $Resolver = [regex]::Match($Source, '(?ms)^function Get-HyperVWindowsVirtualMachines\(\[object\]\$Selector\) \{.*?^\}\r?\n')
    if (-not $Resolver.Success) { throw 'vm-resolver-missing' }
    # The fake advanced function emits its own command name in FullyQualifiedErrorId.
    # The shipped FQID and Hyper-V-qualified command are asserted by the TS boundary test.
    $FakeResolver = $Resolver.Value.Replace('Hyper-V\Get-VM', 'Get-FakeVM').Replace(
        'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM',
        'ObjectNotFound,Get-FakeVM'
    ).Replace(
        'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVM',
        'InvalidParameter,Get-FakeVM'
    )
    . ([scriptblock]::Create($FakeResolver))

    $script:VmId = [Guid]'11111111-2222-3333-4444-555555555555'
    $script:VmName = 'ccc-vm-absence-test'
    function Get-FakeVM {
        [CmdletBinding()]
        param([Guid]$Id, [string[]]$Name)

        $Scoped = $PSBoundParameters.ContainsKey('Id') -or $PSBoundParameters.ContainsKey('Name')
        $global:VmAbsenceReads += $(if ($Scoped) { 'scoped' } else { 'inventory' })
        if ($Scoped) {
            $ErrorId = switch ($global:VmAbsenceMode) {
                'invalid-name' { 'InvalidParameter' }
                'invalid-parameter-wrong-category' { 'InvalidParameter' }
                'wrong-error' { 'ProviderFailure' }
                default { 'ObjectNotFound' }
            }
            $Category = switch ($global:VmAbsenceMode) {
                'invalid-name' { [Management.Automation.ErrorCategory]::InvalidArgument }
                'invalid-parameter-wrong-category' { [Management.Automation.ErrorCategory]::ObjectNotFound }
                'wrong-error' { [Management.Automation.ErrorCategory]::InvalidOperation }
                default { [Management.Automation.ErrorCategory]::ObjectNotFound }
            }
            $Record = [Management.Automation.ErrorRecord]::new(
                [Exception]::new('fake scoped read failed'), $ErrorId, $Category, $null
            )
            $PSCmdlet.WriteError($Record)
            return
        }
        if ($global:VmAbsenceMode -eq 'inventory-fail') {
            $Record = [Management.Automation.ErrorRecord]::new(
                [Exception]::new('fake inventory failed'), 'ProviderFailure',
                [Management.Automation.ErrorCategory]::InvalidOperation, $null
            )
            $PSCmdlet.WriteError($Record)
            return
        }
        if ($global:VmAbsenceMode -eq 'inventory-present') {
            return [pscustomobject]@{ Id = $script:VmId; Name = $script:VmName }
        }
    }
}

Describe 'typed Hyper-V VM absence confirmation' {
    BeforeEach {
        $global:VmAbsenceMode = 'missing'
        $global:VmAbsenceReads = @()
    }

    It 'confirms an absent ID with a successful inventory read' {
        @(Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'id'; id = $script:VmId.ToString('D') })).Count | Should -Be 0
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'confirms an absent name with a successful inventory read' {
        @(Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'name'; name = $script:VmName })).Count | Should -Be 0
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'confirms a valid absent name reported as InvalidParameter' {
        $global:VmAbsenceMode = 'invalid-name'
        @(Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'name'; name = $script:VmName })).Count | Should -Be 0
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'rejects InvalidParameter with a different category' {
        $global:VmAbsenceMode = 'invalid-parameter-wrong-category'
        { Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'name'; name = $script:VmName }) } |
            Should -Throw 'fake scoped read failed'
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped'
    }

    It 'does not mistake a failing inventory for VM absence' {
        $global:VmAbsenceMode = 'inventory-fail'
        { Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'id'; id = $script:VmId.ToString('D') }) } |
            Should -Throw 'fake inventory failed'
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'keeps a matching VM found by the confirmation read' {
        $global:VmAbsenceMode = 'inventory-present'
        $VMs = @(Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'name'; name = $script:VmName }))
        $VMs.Count | Should -Be 1
        $VMs[0].Id | Should -Be $script:VmId
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'propagates a different scoped native error without reading inventory' {
        $global:VmAbsenceMode = 'wrong-error'
        { Get-HyperVWindowsVirtualMachines ([pscustomobject]@{ kind = 'name'; name = $script:VmName }) } |
            Should -Throw 'fake scoped read failed'
        ($global:VmAbsenceReads -join ',') | Should -Be 'scoped'
    }

    AfterAll {
        Remove-Variable -Scope Global -Name VmAbsenceMode, VmAbsenceReads -ErrorAction SilentlyContinue
    }
}
