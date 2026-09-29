import { homedir } from "node:os";
import { join } from "node:path";
import { createResumeProcessRunner } from "./codex-resume-process.js";
import { runCodexResumeRecovery, type CodexResumeRecoveryPlan } from "./codex-resume-recovery-runtime.js";

function parsePlan(input: string | undefined): CodexResumeRecoveryPlan {
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
    try {
        const value: unknown = JSON.parse(input ?? "");
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const plan = value as Record<string, unknown>;
            if (strings(plan.command) && plan.command.length > 0 && strings(plan.retry) && plan.retry.length > 0
                && strings(plan.config) && (plan.selector === undefined || typeof plan.selector === "string")) {
                return { command: plan.command, retry: plan.retry, config: plan.config, selector: plan.selector };
            }
        }
    } catch { /* Do not echo malformed payloads, which may contain configuration values. */ }
    throw new Error("Invalid Codex resume recovery invocation.");
}

function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unexpected runtime error";
    process.stderr.write(`[ccc] Resume recovery failed: ${message.slice(0, 2000)}\n`);
}

async function main(): Promise<number> {
    const plan = parsePlan(process.argv[1]);
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const runner = createResumeProcessRunner();
    try {
        return await runCodexResumeRecovery(plan, runner, home, message => { process.stderr.write(message); });
    } catch (error) {
        reportError(error);
        return runner.interrupted || 1;
    }
}

void main().then(code => { process.exitCode = code; }, error => {
    reportError(error);
    process.exitCode = 1;
});
