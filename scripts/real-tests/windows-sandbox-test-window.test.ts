import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { findWindowsSandboxTestWindow, windowsSandboxTestWindow, windowsSandboxTestWindowPid, windowsSandboxTestWindowObservation } from "./windows-sandbox-test-window.ts";

const deviceId = "windows-real-sandbox-1790933303000";
const uploadedPath = "C:\\Users\\WDAGUtilityAccount\\Desktop\\ccc-upload.txt";

it("launches a self-contained guest window within the public exec command bound", () => {
    const { command } = windowsSandboxTestWindow(deviceId, uploadedPath);
    expect(toolInputError("exec", { deviceId, command, detail: true, timeoutMs: 180000 })).toBeNull();
    expect(command).not.toMatch(/notepad|cmd\.exe|Start-Sleep|-Wait\b/i);
    expect(() => windowsSandboxTestWindow(deviceId, "x".repeat(4096))).toThrow("sandbox-test-window-command-too-long");
});

it.each([undefined, null, "", "0", "-1", "abc", "12\n13", "4294967296", 123])("rejects invalid or ambiguous launch PID %j", (value) => {
    expect(windowsSandboxTestWindowPid(value)).toBeNull();
});
it("accepts one decimal PID with normal PowerShell line endings", () => {
    expect(windowsSandboxTestWindowPid("123\r\n")).toBe(123);
});

it("ignores unrelated windows and invalid handles even with a matching title or PID", () => {
    const title = windowsSandboxTestWindow(deviceId, uploadedPath).title;
    const unrelated = [null, { processId: 42, title, handle: "1" },
        { processId: 123, title: title + " other", handle: "2" },
        { processId: 123, title, handle: "0" }, { processId: 123, title, handle: "bad" }];
    expect(findWindowsSandboxTestWindow(unrelated, 123, title)).toBeUndefined();
    const owned = { processId: 123, title, handle: "8589934592" };
    expect(findWindowsSandboxTestWindow([...unrelated, owned], 123, title)).toBe(owned);
});

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10000, windowsHide: true }).status === 0;
describe.skipIf(!available)("generated window PowerShell", () => {
    it("passes a parsed STA script as one encoded argument and emits only the child PID", () => {
        const path = "C:\\User's folder\\$(throw 'injection')\\한글.txt";
        const { command, title } = windowsSandboxTestWindow(deviceId, path);
        const harness = `
$ErrorActionPreference = 'Stop'
function Test-WindowStart {
 param($Info)
 if ($Info.FileName -ne (Join-Path $PSHOME 'powershell.exe') -or !$Info.CreateNoWindow -or $Info.UseShellExecute -or $Info.WindowStyle -ne 'Normal') { throw 'launch-contract' }
 if ($Info.Arguments -notmatch '^-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$') { throw 'arguments' }
 $script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
 $tokens=$null; $errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors)
 if ($errors.Count -ne 0) { throw 'invalid-script' }
 $strings=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true) | ForEach-Object Value)
 $expectedPath=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(path, "utf16le").toString("base64")}'))
 if ($strings -notcontains $expectedPath -or $strings -notcontains '${title}') { throw 'literal-corruption' }
 [pscustomobject]@{ Id=12345 }
}
${command.replace("[System.Diagnostics.Process]::Start($Info)", "(Test-WindowStart $Info)")}
`;
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")],
            { encoding: "utf8", windowsHide: true, timeout: 10000 });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("12345");
    });
});


it("bounds observation to the launched process and test-owned phase path", () => {
    const command = windowsSandboxTestWindowObservation(123, uploadedPath + ".window.json");
    expect(toolInputError("exec", { deviceId, command, detail: true, timeoutMs: 10000 })).toBeNull();
    expect(command).toContain("Get-Process -Id 123");
    expect(() => windowsSandboxTestWindowObservation(NaN, uploadedPath)).toThrow("pid-invalid");
});

it.skipIf(!available)("records a bounded child initialization failure before any window can exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-window-child-"));
    try {
        const { command, evidencePath } = windowsSandboxTestWindow(deviceId, join(root, "uploaded.txt"));
        const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
        const script = Buffer.from(encoded, "base64").toString("utf16le");
        const harness = `function Add-Type { throw ('private-error' * 300) }; ${script}`;
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(harness, "utf16le").toString("base64")],
            { encoding: "utf8", windowsHide: true, timeout: 10000 });
        expect(result.status).toBe(1);
        const phase = JSON.parse(readFileSync(evidencePath, "utf8").replace(/^\uFEFF/, ""));
        expect(phase.stage).toBe("failed");
        expect(phase.pid).toBeGreaterThan(0);
        expect(phase.error).toHaveLength(2048);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
