import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it } from "vitest";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10_000, windowsHide: true }).status === 0;

it.skipIf(!available)("publishes and atomically replaces every guest stage using the real PowerShell helper", () => {
    const root = mkdtempSync(join(tmpdir(), "nested-progress-file-"));
    try {
        const job = readFileSync("scripts/real-tests/nested-hyper-v-job.ps1", "utf8");
        const helper = job.slice(job.indexOf("function Write-JobProgress"), job.indexOf("function Clear-NestedCheckout"));
        const script = join(root, "test.ps1");
        writeFileSync(script, [
            "$ErrorActionPreference='Stop'",
            `$Run='${root.replaceAll("'", "''")}';$RunId='${"a".repeat(32)}'`,
            helper,
            "$records=@();foreach($stage in @('bootstrap','install','build','test','cleanup')){Write-JobProgress $stage;$records+=Get-Content -Raw -LiteralPath (Join-Path $Run 'progress.json')|ConvertFrom-Json}",
            "@{records=$records;pending=(Test-Path -LiteralPath (Join-Path $Run 'progress.pending.json'))}|ConvertTo-Json -Depth 4 -Compress",
        ].join("\n"));
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
        expect(result.status, result.stderr || String(result.error || "")).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual({
            records: ["bootstrap", "install", "build", "test", "cleanup"].map(stage => ({ kind: "progress", runId: "a".repeat(32), stage })),
            pending: false,
        });
    } finally { rmSync(root, { recursive: true, force: true }); }
});
