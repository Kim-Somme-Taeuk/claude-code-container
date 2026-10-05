import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Collect generated source without executing PowerShell or starting a VM.
// Kept separate from the native parser so all hosts can test export wiring.
export function nestedDevelopmentPrograms(repoRoot) {
    const module = pathToFileURL(join(repoRoot, "scripts", "real-tests", "nested-hyper-v.ts")).href;
    const claims = pathToFileURL(join(repoRoot, "scripts", "real-tests", "nested-hyper-v-claim.ts")).href;
    const probe = spawnSync(process.execPath, ["--import", "tsx", "-e",
        `Promise.all([import(${JSON.stringify(module)}),import(${JSON.stringify(claims)})]).then(([m,c]) => process.stdout.write(JSON.stringify([c.nestedClaimCommand('a'.repeat(32)),c.nestedCompleteClaimCommand('a'.repeat(32)),m.NESTED_PREPARE_COMMAND,m.nestedLaunchCommand('a'.repeat(32),'b'.repeat(64),'22.23.2','windows')])))`,
    ], { cwd: repoRoot, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error("nested-development-programs-unavailable");
    let programs;
    try { programs = JSON.parse(probe.stdout); }
    catch { throw new Error("nested-development-programs-invalid"); }
    if (!Array.isArray(programs) || programs.length !== 4 || programs.some(p => typeof p !== "string" || !p.trim())) {
        throw new Error("nested-development-programs-invalid");
    }
    return programs;
}
