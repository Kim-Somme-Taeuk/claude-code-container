import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsHelperBootstrapScript, windowsHelperScript } from "@ccc/device-lab/providers/backends/windows-sandbox.mjs";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10000, windowsHide: true }).status === 0;
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc-bootstrap-"));
    const tools = join(root, "tools");
    const downloads = join(root, "downloads");
    mkdirSync(tools); mkdirSync(downloads);
    const script = join(root, "helper.ps1");
    writeFileSync(join(tools, "ccc-guest-helper.ps1"), "# fixture helper");
    return { root, tools, downloads, script };
}
function execute(path: string, extra: string[] = []) {
    return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path, ...extra], { encoding: "utf8", timeout: 10000, windowsHide: true });
}
function bootstrapFixture(mode: string) {
    const f = fixture();
    const bootstrap = join(f.root, "bootstrap.ps1");
    writeFileSync(bootstrap, windowsHelperBootstrapScript({ guestToolsDir: f.tools, guestHelperScript: f.script, guestDownloadsDir: f.downloads }));
    const harness = join(f.root, "harness.ps1");
    writeFileSync(harness, `
$ErrorActionPreference='Stop'
$global:Mode=${ps(mode)}
$global:State=${ps(join(f.root, "live"))}
$global:Starts=${ps(join(f.root, "starts"))}
$global:Exe=Join-Path $PSHOME 'powershell.exe'
$global:Helper=${ps(f.script)}
$global:Born=[DateTime]::SpecifyKind([DateTime]::Parse('2026-10-04T00:00:00'),[DateTimeKind]::Utc)
function Get-CimInstance {
 param($ClassName,$Filter,$OperationTimeoutSec,$ErrorAction)
 if($OperationTimeoutSec -ne 2){throw 'CIM timeout omitted'}
 if($global:Mode -ne 'phase-write-failed'){
  $phase=Get-Content -Raw -LiteralPath ${ps(join(f.downloads, 'ccc-guest-helper-bootstrap-phase.json'))} | ConvertFrom-Json
  if($phase.stage -ne 'inspect-helper'){throw 'early phase missing'}
 }
 if($global:Mode -eq 'cim-failed'){throw 'private-host-text C:\\secret'}
 if($global:Mode -in @('absent','dead','phase-write-failed') -and !(Test-Path $global:State)){return}
 $command='"'+$global:Exe+'" -NoProfile -ExecutionPolicy Bypass -File "'+$global:Helper+'"'
 if($global:Mode -eq 'one-shot'){$command+=' -OnceRequestPath request.json'}
 if($global:Mode -eq 'inaccessible'){$command=$null}
 $session=if($global:Mode -eq 'foreign'){2}else{1}
 $count=if($global:Mode -eq 'ambiguous'){2}else{1}
 for($i=0;$i -lt $count;$i++){
  [pscustomobject]@{ProcessId=(600001+$i);CommandLine=$command;ExecutablePath=$global:Exe;SessionId=$session;CreationDate=$global:Born}
 }
}
function Get-Process {
 param($Id,$ErrorAction)
 $born=if($global:Mode -eq 'recycled'){$global:Born.AddSeconds(1)}else{$global:Born}
 [pscustomobject]@{Id=$Id;HasExited=$false;SessionId=1;Path=$global:Exe;StartTime=$born}
}
function Start-Process {
 param($FilePath,$ArgumentList,$RedirectStandardOutput,$RedirectStandardError,$WindowStyle,[switch]$PassThru)
 if($FilePath -cne $global:Exe){throw 'wrong executable'}
 if($WindowStyle -ne 'Hidden'){throw 'foreground launch'}
 Add-Content -LiteralPath $global:Starts -Value 'start'
 Set-Content -LiteralPath $global:State -Value 'live'
 Start-Sleep -Milliseconds 250
 [pscustomobject]@{Id=600001}
}
& ${ps(bootstrap)}
`);
    return { ...f, bootstrap, harness };
}

// Execute the generated program with real OS mutexes, mocking only guest process discovery/launch.
describe.skipIf(!available)("generated Sandbox PowerShell bootstrap", () => {
    it.each(["live", "absent", "dead", "one-shot", "ambiguous", "foreign", "recycled", "inaccessible", "cim-failed"])("handles %s helper identity without unsafe relaunch", mode => {
        const f = bootstrapFixture(mode);
        try {
            const shouldStart = ["absent", "dead", "one-shot"].includes(mode);
            const shouldFail = ["ambiguous", "foreign", "recycled", "inaccessible", "cim-failed"].includes(mode);
            const logs = ["ccc-guest-helper-bootstrap.stdout.txt", "ccc-guest-helper-bootstrap.stderr.txt", "ccc-guest-helper.stdout.txt", "ccc-guest-helper.stderr.txt"];
            if (mode === "live" || shouldFail) for (const name of logs) writeFileSync(join(f.downloads, name), "existing log contents");
            const result = execute(f.harness);
            expect(result.status, result.stderr).toBe(shouldFail ? 1 : 0);
            expect(existsSync(join(f.root, "starts"))).toBe(shouldStart);
            expect(existsSync(f.script)).toBe(shouldStart);
            const phase = JSON.parse(readFileSync(join(f.downloads, "ccc-guest-helper-bootstrap-phase.json"), "utf8"));
            expect(phase).toMatchObject({ schemaVersion: 1, stage: shouldFail ? "failed" : shouldStart ? "helper-started" : "helper-reused" });
            if (mode === "inaccessible") expect(phase.error).toBe("helper-process-identity-unavailable");
            if (mode === "cim-failed") expect(phase.error).toBe("helper-bootstrap-command-failed");
            expect(JSON.stringify(phase)).not.toMatch(/private|secret/);
            if (mode === "live" || shouldFail) {
                for (const name of logs) expect(readFileSync(join(f.downloads, name), "utf8")).toBe("existing log contents");
            }
        } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
    it("keeps phase-file I/O failures from changing the bootstrap outcome", () => {
        const f = bootstrapFixture("phase-write-failed");
        try {
            mkdirSync(join(f.downloads, "ccc-guest-helper-bootstrap-phase.json.tmp"));
            const result = execute(f.harness);
            expect(result.status, result.stderr).toBe(0);
            expect(existsSync(join(f.root, "starts"))).toBe(true);
            expect(existsSync(join(f.downloads, "ccc-guest-helper-bootstrap-phase.json"))).toBe(false);
        } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
    it("serializes overlapping bootstraps and reuses the process on the subsequent retry", async () => {
        const f = bootstrapFixture("absent");
        const children: ReturnType<typeof spawn>[] = [];
        try {
            const run = () => new Promise<number | null>((resolve, reject) => {
                const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", f.harness], { windowsHide: true, stdio: "ignore" });
                children.push(child); child.once("error", reject); child.once("exit", resolve);
            });
            expect(await Promise.all([run(), run()])).toEqual([0, 0]);
            expect(execute(f.harness).status).toBe(0);
            expect(readFileSync(join(f.root, "starts"), "utf8").trim().split(/\r?\n/)).toEqual(["start"]);
            expect(existsSync(join(f.downloads, "ccc-guest-helper-bootstrap.stderr.txt"))).toBe(false);
        } finally { for (const child of children) if (child.exitCode === null) child.kill(); rmSync(f.root, { recursive: true, force: true }); }
    });
    it("runs one daemon, permits a one-shot request, and recovers an abandoned daemon mutex", async () => {
        const f = fixture();
        const inbox = join(f.root, "inbox"); const outbox = join(f.root, "outbox");
        writeFileSync(f.script, windowsHelperScript({ guestInboxDir: inbox, guestOutboxDir: outbox, guestUploadsDir: join(f.root, "uploads"), guestDownloadsDir: f.downloads }));
        const children: ReturnType<typeof spawn>[] = [];
        const ready = join(f.downloads, "ccc-guest-helper.ready.txt");
        const launch = () => { const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-File", f.script], { windowsHide: true, stdio: "ignore" }); children.push(child); return child; };
        const waitReady = async () => {
            const deadline = Date.now() + 8000;
            while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
            expect(existsSync(ready)).toBe(true);
        };
        try {
            const first = launch(); await waitReady();
            expect(execute(f.script).status).toBe(0); // A duplicate daemon returns instead of polling.
            expect(first.exitCode).toBeNull();
            const request = join(f.root, "one-shot.json");
            writeFileSync(request, JSON.stringify({ id: "probe", type: "unknown-fixture-request" }));
            expect(execute(f.script, ["-OnceRequestPath", request]).status).toBe(0);
            expect(JSON.parse(readFileSync(join(outbox, "probe.json"), "utf8"))).toMatchObject({ id: "probe", ok: false });
            const exited = new Promise(resolve => first.once("exit", resolve)); first.kill(); await exited;
            rmSync(ready); launch(); await waitReady();
        } finally {
            await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => { child.once("exit", resolve); child.kill(); })));
            rmSync(f.root, { recursive: true, force: true });
        }
    }, 30000);
});

it("keeps both generated programs compatible with the single-instance contract", () => {
    const helper = windowsHelperScript({ guestInboxDir: "C:\\ccc\\scratch\\inbox", guestOutboxDir: "C:\\ccc\\scratch\\outbox", guestUploadsDir: "C:\\ccc\\scratch\\uploads", guestDownloadsDir: "C:\\ccc\\scratch\\downloads" });
    const bootstrap = windowsHelperBootstrapScript({ guestToolsDir: "C:\\ccc\\tools", guestHelperScript: "C:\\ccc\\scratch\\ccc-guest-helper.ps1", guestDownloadsDir: "C:\\ccc\\scratch\\downloads" });
    expect(bootstrap.indexOf("$BootstrapMutex.WaitOne(0)")).toBeLessThan(bootstrap.indexOf("Set-Content -Path $BootstrapStdoutPath"));
    expect(bootstrap.indexOf("$LiveHelpers.Count -eq 1")).toBeLessThan(bootstrap.indexOf("Copy-Item"));
    expect(bootstrap).toContain("AbandonedMutexException");
    expect(helper.indexOf("if ($OnceRequestPath)")).toBeLessThan(helper.indexOf("$DaemonMutex.WaitOne(0)"));
    expect(helper).toContain("$DaemonMutex.ReleaseMutex()");
});
