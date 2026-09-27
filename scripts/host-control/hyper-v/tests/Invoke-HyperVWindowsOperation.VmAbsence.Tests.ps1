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

    $ExactNames = [regex]::Match($Source, '(?ms)^function Get-HyperVWindowsVirtualMachinesByExactNames\(\[string\[\]\]\$RequestedNames\) \{.*?^\}\r?\n')
    if (-not $ExactNames.Success) { throw 'vm-exact-names-missing' }
    $FakeExactNames = $ExactNames.Value.Replace('Hyper-V\Get-VM', 'Get-FakeExactNameVM').Replace(
        'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM',
        'ObjectNotFound,Get-FakeExactNameVM'
    ).Replace(
        'InvalidParameter,Microsoft.HyperV.PowerShell.Commands.GetVM',
        'InvalidParameter,Get-FakeExactNameVM'
    )
    . ([scriptblock]::Create($FakeExactNames))

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

    $script:PresentVm = [pscustomobject]@{
        Id = [Guid]'66666666-7777-8888-9999-aaaaaaaaaaaa'
        Name = 'ccc-vm-exact-present'
        Notes = 'ccc-owned'
    }
    $script:MissingVmName = 'ccc-vm-exact-missing'
    # A batch read resolves each requested name on its own: present names are emitted, and every
    # missing name writes one native record whose TargetObject is that name.
    function Get-FakeExactNameVM {
        [CmdletBinding()]
        param([string[]]$Name)

        $Scoped = $PSBoundParameters.ContainsKey('Name')
        $global:ExactNameReads += $(if ($Scoped) { 'scoped' } else { 'inventory' })
        if ($Scoped) {
            foreach ($RequestedName in $Name) {
                $Present = @($global:ExactNameScopedVMs | Where-Object { [string]$_.Name -ceq $RequestedName })
                if ($Present.Count -gt 0) {
                    $Present
                    continue
                }
                $Record = [Management.Automation.ErrorRecord]::new(
                    [Exception]::new('fake exact-name read failed'), $global:ExactNameErrorId,
                    $global:ExactNameCategory, $RequestedName
                )
                $PSCmdlet.WriteError($Record)
            }
            return
        }
        if ($global:ExactNameInventoryFails) {
            $Record = [Management.Automation.ErrorRecord]::new(
                [Exception]::new('fake inventory failed'), 'ProviderFailure',
                [Management.Automation.ErrorCategory]::InvalidOperation, $null
            )
            $PSCmdlet.WriteError($Record)
            return
        }
        return $global:ExactNameInventory
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

Describe 'typed Hyper-V batch exact-name VM absence confirmation' {
    BeforeEach {
        $global:ExactNameErrorId = 'InvalidParameter'
        $global:ExactNameCategory = [Management.Automation.ErrorCategory]::InvalidArgument
        $global:ExactNameScopedVMs = @()
        $global:ExactNameInventory = @()
        $global:ExactNameInventoryFails = $false
        $global:ExactNameReads = @()
    }

    It 'confirms a missing name reported as InvalidParameter with an empty inventory read' {
        @(Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName)).Count | Should -Be 0
        ($global:ExactNameReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'does not mistake a failing inventory for absence after InvalidParameter' {
        $global:ExactNameInventoryFails = $true
        { Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName) } | Should -Throw 'fake inventory failed'
        ($global:ExactNameReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'confirms a missing name reported as ObjectNotFound with an inventory read' {
        $global:ExactNameErrorId = 'ObjectNotFound'
        $global:ExactNameCategory = [Management.Automation.ErrorCategory]::ObjectNotFound
        @(Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName)).Count | Should -Be 0
        ($global:ExactNameReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'rejects InvalidParameter with a different category without reading inventory' {
        $global:ExactNameCategory = [Management.Automation.ErrorCategory]::ObjectNotFound
        { Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName) } | Should -Throw 'fake exact-name read failed'
        ($global:ExactNameReads -join ',') | Should -Be 'scoped'
    }

    It 'propagates an unspecified native error without reading inventory' {
        $global:ExactNameErrorId = 'Unspecified'
        $global:ExactNameCategory = [Management.Automation.ErrorCategory]::NotSpecified
        { Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName) } | Should -Throw 'fake exact-name read failed'
        ($global:ExactNameReads -join ',') | Should -Be 'scoped'
    }

    It 'keeps a matching VM found by the confirmation read' {
        $global:ExactNameInventory = @($script:PresentVm)
        $VMs = @(Get-HyperVWindowsVirtualMachinesByExactNames @($script:PresentVm.Name))
        $VMs.Count | Should -Be 1
        $VMs[0].Id | Should -Be $script:PresentVm.Id
        ($global:ExactNameReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'returns only the present VM from a mix of present and missing names' {
        $global:ExactNameScopedVMs = @($script:PresentVm)
        $global:ExactNameInventory = @(
            $script:PresentVm,
            [pscustomobject]@{ Id = [Guid]'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'; Name = 'CCC-VM-EXACT-MISSING'; Notes = '' },
            [pscustomobject]@{ Id = [Guid]'cccccccc-dddd-eeee-ffff-000000000000'; Name = 'ccc-vm-unrequested'; Notes = '' }
        )
        $VMs = @(Get-HyperVWindowsVirtualMachinesByExactNames @($script:PresentVm.Name, $script:MissingVmName))
        $VMs.Count | Should -Be 1
        $VMs[0].Id | Should -Be $script:PresentVm.Id
        $VMs[0].Name | Should -BeExactly $script:PresentVm.Name
        ($global:ExactNameReads -join ',') | Should -Be 'scoped,inventory'
    }

    It 'returns resolved names without reading inventory' {
        $global:ExactNameScopedVMs = @($script:PresentVm)
        $VMs = @(Get-HyperVWindowsVirtualMachinesByExactNames @($script:PresentVm.Name))
        $VMs.Count | Should -Be 1
        $VMs[0].Id | Should -Be $script:PresentVm.Id
        ($global:ExactNameReads -join ',') | Should -Be 'scoped'
    }

    It 'rejects empty, oversized, and duplicate name lists before any read' {
        { Get-HyperVWindowsVirtualMachinesByExactNames @() } | Should -Throw 'inventory-names-invalid'
        $Oversized = @(1..33 | ForEach-Object { "ccc-vm-exact-$_" })
        { Get-HyperVWindowsVirtualMachinesByExactNames $Oversized } | Should -Throw 'inventory-names-invalid'
        { Get-HyperVWindowsVirtualMachinesByExactNames @($script:MissingVmName, $script:MissingVmName) } |
            Should -Throw 'inventory-names-duplicate'
        $global:ExactNameReads.Count | Should -Be 0
    }

    AfterAll {
        Remove-Variable -Scope Global -Name ExactNameErrorId, ExactNameCategory, ExactNameScopedVMs, ExactNameInventory, ExactNameInventoryFails, ExactNameReads -ErrorAction SilentlyContinue
    }
}
