const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

// The real E2E owns the entire Sandbox and tears it down in finally. Avoid
// optional guest applications such as Notepad for its window-list/focus proof.
export function windowsSandboxTestWindow(deviceId: string, uploadedPath: string) {
    const title = `CCC Sandbox E2E ${deviceId}`;
    const evidencePath = `${uploadedPath}.window.json`;
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `$Evidence = ${psLiteral(evidencePath)}`,
        "function Phase($stage,$errorText='') { @{stage=$stage;pid=$PID;error=$errorText.Substring(0,[Math]::Min(2048,$errorText.Length))} | ConvertTo-Json -Compress | Set-Content -LiteralPath $Evidence -Encoding UTF8 }",
        "try {",
        "Phase 'starting'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$Form = New-Object System.Windows.Forms.Form",
        `$Form.Text = ${psLiteral(title)}`,
        "$Form.Width = 640; $Form.Height = 480",
        "$Text = New-Object System.Windows.Forms.TextBox",
        "$Text.Multiline = $true; $Text.Dock = 'Fill'",
        `$Text.Text = Get-Content -Raw -LiteralPath ${psLiteral(uploadedPath)}`,
        "$Form.Controls.Add($Text)",
        "$Form.add_Shown({ Phase 'shown' })",
        "try { [void]$Form.ShowDialog() } finally { $Form.Dispose() }",
        "} catch { Phase 'failed' $_.Exception.Message; exit 1 }",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const command = `$Info = New-Object System.Diagnostics.ProcessStartInfo; $Info.FileName = Join-Path $PSHOME 'powershell.exe'; $Info.Arguments = '-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand ${encoded}'; $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true; $Window = [System.Diagnostics.Process]::Start($Info); Write-Output $Window.Id`;
    if (command.length > 4096) throw new Error("sandbox-test-window-command-too-long");
    return { title, command, evidencePath };
}

export function windowsSandboxTestWindowObservation(pid: number, evidencePath: string) {
    if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw new Error("sandbox-test-window-pid-invalid");
    return `$Process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; $Phase = if (Test-Path -LiteralPath ${psLiteral(evidencePath)}) { Get-Content -Raw -LiteralPath ${psLiteral(evidencePath)} } else { 'absent' }; @{ alive=($null -ne $Process); phase=$Phase } | ConvertTo-Json -Compress`;
}

export function windowsSandboxTestWindowPid(stdout: unknown): number | null {
    if (typeof stdout !== "string" || !/^[1-9][0-9]{0,9}$/.test(stdout.trim())) return null;
    const pid = Number(stdout.trim());
    return pid <= 0xffffffff ? pid : null;
}

export function findWindowsSandboxTestWindow(windows: any[], pid: number, title: string): { handle: string } | undefined {
    return windows.find(window => window?.processId === pid && window?.title === title
        && typeof window?.handle === "string" && /^[1-9][0-9]{0,19}$/.test(window.handle));
}
