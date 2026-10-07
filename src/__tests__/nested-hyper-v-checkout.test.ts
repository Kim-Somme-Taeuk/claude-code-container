import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { nestedCheckoutCases, nestedCheckoutFixtureSetup } from "./helpers/nested-checkout-cases.js";

const job = readFileSync(join(process.cwd(), "scripts/real-tests/nested-hyper-v-job.ps1"), "utf8");
const helper = job.slice(job.indexOf("function Clear-NestedCheckout"), job.indexOf("\ntry {\n    Write-JobProgress"));
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const linkType = process.platform === "win32" ? "Junction" : "SymbolicLink";
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10_000, windowsHide: true }).status === 0;
const symbolicLinksAvailable = available && process.platform === "win32" && canCreateFileSymbolicLink();

function canCreateFileSymbolicLink(): boolean {
    const temporary = mkdtempSync(join(tmpdir(), "nested-checkout-link-probe-"));
    try {
        const fixture = temporary.replaceAll("'", "''");
        return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference='Stop'
$Target=Join-Path '${fixture}' 'target'
Set-Content -LiteralPath $Target -Value 'probe'
New-Item -ItemType SymbolicLink -Path (Join-Path '${fixture}' 'link') -Target $Target | Out-Null
`], { timeout: 10_000, windowsHide: true }).status === 0;
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

function run(body: string) {
    const temporary = mkdtempSync(join(tmpdir(), "nested-checkout-"));
    try {
        const script = join(temporary, "test.ps1");
        writeFileSync(script, [
            "$ErrorActionPreference='Stop'",
            helper,
            nestedCheckoutFixtureSetup(linkType),
            `$Fixture='${temporary.replaceAll("'", "''")}'`,
            "$Source=Join-Path $Fixture 'checkout'",
            "$Marker=Join-Path $Source '.ccc-nested-checkout'",
            "[IO.Directory]::CreateDirectory($Source) | Out-Null",
            "Set-Content -LiteralPath $Marker -Value ('a'*32) -Encoding ASCII",
            body,
        ].join("\n"));
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
        expect(result.status, result.stderr || String(result.error || "")).toBe(0);
        return JSON.parse(result.stdout.trim());
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

describe.skipIf(!available)("nested checkout cleanup PowerShell", () => {
    for (const fixture of nestedCheckoutCases(linkType)) {
        it.skipIf((fixture.windowsOnly && process.platform !== "win32") || (fixture.requiresSymbolicLink && !symbolicLinksAvailable))(fixture.name, () => {
            expect(run(fixture.body)).toEqual(fixture.expected);
        });
    }
});
