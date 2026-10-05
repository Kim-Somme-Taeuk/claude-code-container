import { spawn } from "child_process";
import { join } from "path";
import { pathToFileURL } from "url";
import { setTimeout as delay } from "timers/promises";
import { runSupervisedProcess } from "./supervised-process.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { repoRoot } from "./helpers.ts";

// Executed inside the dedicated L1 only. The broker is our child from this build,
// never an auto-launched globally installed CCC or the outer host's broker.
export async function runNestedGuest(target: string) {
    if (process.platform !== "win32" || process.env.CCC_HYPER_V_NESTED_HOST !== "1") throw new Error("nested-guest-only");
    if (!["linux", "windows"].includes(target)) throw new Error("nested-target-invalid");
    return withExclusiveRealProviderRun("nested Hyper-V", async () => {
        const broker = spawn(process.execPath, [join(repoRoot, "dist/index.js"), "devices", "broker", "serve", "--host", "127.0.0.1", "--port", "17373"], { cwd: repoRoot, stdio: "inherit", windowsHide: true });
        let launchError: Error | undefined;
        broker.on("error", error => { launchError = error; });
        try {
            let ready = false;
            for (let attempt = 0; attempt < 60; attempt++) {
                if (launchError) throw launchError;
                if (broker.exitCode !== null) throw new Error("nested-candidate-broker-exited");
                try {
                    const response = await fetch("http://127.0.0.1:17373/status", { signal: AbortSignal.timeout(2000) });
                    const status = await response.json() as any;
                    if (response.ok && status.broker?.process?.pid === broker.pid) { ready = true; break; }
                    if (response.ok) throw new Error("nested-broker-port-owned-by-another-process");
                } catch (error) {
                    if (error.message === "nested-broker-port-owned-by-another-process") throw error;
                }
                await delay(1000);
            }
            if (!ready) throw new Error("nested-candidate-broker-not-ready");
            const result = await runSupervisedProcess(process.execPath, ["--import", "tsx", "scripts/real-tests/run.ts", `scripts/real-tests/level2-hyper-v-${target}-vm.ts`], {
                cwd: repoRoot, env: { ...process.env, CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP: "1" }, timeout: 3 * 60 * 60 * 1000,
            });
            if (result.status !== 0) throw new Error(`nested-provider-test-failed: ${result.status}`);
        } finally {
            // Only terminate the child handle this run owns, never a discovered PID.
            if (broker.exitCode === null) broker.kill();
            await Promise.race([new Promise<void>(resolve => broker.once("exit", () => resolve())), delay(5000)]);
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runNestedGuest(process.argv[2] || "windows").catch(error => { console.error(error.message); process.exitCode = 1; });
}
