/** Shared guest-side implementation; parameters allow native tests without rebooting a guest. */
export const NESTED_CLAIM_FUNCTIONS = String.raw`
function Assert-NestedPlainItem($Path, [bool]$Directory) {
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType -or ($item.PSIsContainer -ne $Directory)) { throw 'nested-claim-unsafe-path' }
  return $item
}
function Assert-NestedBootId($BootId) {
  if ($BootId -isnot [string] -or $BootId -cnotmatch '^[0-9]{8}T[0-9]{13}Z\z') { throw 'nested-claim-invalid-boot' }
  [void][DateTime]::ParseExact($BootId,'yyyyMMddTHHmmssfffffffZ',[Globalization.CultureInfo]::InvariantCulture)
}
function Invoke-NestedClaim([string]$Root, [string]$RunId, [string]$BootId, [string]$Operation, [string]$MutexName) {
  if ($RunId -cnotmatch '^[a-f0-9]{32}\z' -or $Operation -cnotin @('acquire','complete')) { throw 'nested-claim-invalid-input' }
  Assert-NestedBootId $BootId
  $mutex=New-Object Threading.Mutex($false,$MutexName)
  $held=$false
  try {
    try { $held=$mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held=$true }
    if (-not $held) { throw 'nested-claim-mutex-timeout' }
    if (Test-Path -LiteralPath $Root) { [void](Assert-NestedPlainItem $Root $true) }
    else { New-Item -ItemType Directory -Path $Root -ErrorAction Stop | Out-Null }
    $acl=New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
      $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Root -AclObject $acl -ErrorAction Stop
    $active=Join-Path $Root 'active'
    $marker=Join-Path $active 'claim.json'
    $exists=Test-Path -LiteralPath $active
    if ($exists) {
      [void](Assert-NestedPlainItem $active $true)
      $children=@(Get-ChildItem -LiteralPath $active -Force -ErrorAction Stop)
      if ($children.Count -ne 1 -or $children[0].Name -cne 'claim.json') { throw 'nested-claim-unknown-content' }
      $item=Assert-NestedPlainItem $marker $false
      if ($item.Length -gt 4096) { throw 'nested-claim-invalid-metadata' }
      $claim=Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $names=@($claim.PSObject.Properties.Name | Sort-Object)
      if (($names -join ',') -cne 'bootId,runId,state' -or $claim.runId -isnot [string] -or $claim.runId -cnotmatch '^[a-f0-9]{32}\z' -or $claim.state -isnot [string] -or $claim.state -cnotin @('active','completed')) { throw 'nested-claim-invalid-metadata' }
      Assert-NestedBootId $claim.bootId
    }
    if ($Operation -ceq 'complete') {
      # Preparation can reboot the VM while this run retains its active claim.
      if (-not $exists -or $claim.runId -cne $RunId -or ($claim.state -ceq 'completed' -and $claim.bootId -cne $BootId)) { throw 'nested-claim-owner-mismatch' }
      @{runId=$RunId;bootId=$BootId;state='completed'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8 -ErrorAction Stop
      Write-Output 'completed'
      return
    }
    if ($exists) {
      if ($claim.state -cne 'completed' -or $claim.bootId -ceq $BootId) { throw 'nested-development-already-claimed' }
      # Never recursively remove unknown content, even if cleanup was interrupted.
      Remove-Item -LiteralPath $marker -ErrorAction Stop
      [IO.Directory]::Delete($active,$false)
    }
    New-Item -ItemType Directory -Path $active -ErrorAction Stop | Out-Null
    @{runId=$RunId;bootId=$BootId;state='active'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8 -ErrorAction Stop
    Write-Output 'claimed'
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}`;

function command(runId: string, operation: "acquire" | "complete"): string {
    if (runId.length !== 32 || !/^[a-f0-9]{32}$/.test(runId)) throw new Error("nested-claim-input-invalid");
    return `$ErrorActionPreference='Stop'\n${NESTED_CLAIM_FUNCTIONS}\n` +
        `$boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime\n` +
        `if ($boot -isnot [DateTime]) { throw 'nested-claim-boot-unavailable' }\n` +
        `$bootId=$boot.ToUniversalTime().ToString('yyyyMMddTHHmmssfffffffZ',[Globalization.CultureInfo]::InvariantCulture)\n` +
        `Invoke-NestedClaim -Root 'C:\\ccc-nested-development' -RunId '${runId}' -BootId $bootId -Operation '${operation}' -MutexName 'Global\\ccc-nested-development-claim'`;
}

export function nestedClaimCommand(runId: string): string { return command(runId, "acquire"); }
export function nestedCompleteClaimCommand(runId: string): string { return command(runId, "complete"); }
