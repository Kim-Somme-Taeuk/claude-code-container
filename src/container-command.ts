import { spawn, spawnSync } from "child_process";

export async function runContainerCommand(runtime: string, args: string[], interactive: boolean): Promise<number> {
    if (!interactive) return spawnSync(runtime, args, { stdio: "inherit" }).status ?? 1;

    return new Promise<number>((resolve) => {
        const child = spawn(runtime, args, { stdio: "inherit" });
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        let settled = false;
        let interrupted = false;
        function finish(status: number): void {
            if (settled) return;
            settled = true;
            child.removeListener("close", onClose);
            child.removeListener("error", onError);
            for (const signal of signals) process.removeListener(signal, interrupt);
            resolve(status);
        }
        function onClose(code: number | null, signal: NodeJS.Signals | null): void {
            finish(!interrupted && signal === null && code !== null && Number.isFinite(code) ? code : 1);
        }
        function onError(): void { finish(1); }
        function interrupt(): void {
            interrupted = true;
            // Existing cleanup handlers exit synchronously, so a grace timer cannot run.
            try { child.kill("SIGKILL"); } catch { /* The owned client may already have exited. */ }
            finish(1);
        }
        child.once("close", onClose);
        child.once("error", onError);
        for (const signal of signals) process.prependListener(signal, interrupt);
    });
}
