import { readFileSync } from "node:fs";
import type { CodexResumeRecoveryPlan } from "./codex-resume-recovery-runtime.js";

const VALUE_OPTIONS = new Set([
    "-c", "--config", "--enable", "--disable", "-m", "--model", "-s", "--sandbox",
    "-a", "--ask-for-approval", "--local-provider", "--add-dir",
]);
const CONFIG_OPTIONS = new Set(["-c", "--config", "--enable", "--disable"]);
const BOOLEAN_OPTIONS = new Set([
    "--no-daemon", "--no-alt-screen", "--oss", "--strict-config", "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--search",
]);
const SELECTOR_OPTIONS = new Set(["--last", "--all", "--include-non-interactive"]);

/** Wrap only local resume without a prompt; the container retains its existing identity and environment. */
export function buildCodexResumeRecoveryCommand(command: readonly string[]): string[] {
    const unchanged = [...command];
    if (command[0] !== "codex") return unchanged;
    let resume = false;
    let selector: string | undefined;
    const retry = [command[0]];
    const config: string[] = [];
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (!argument.startsWith("-")) {
            if (!resume) {
                if (argument !== "resume") return unchanged;
                resume = true;
                retry.push(argument);
            } else if (selector === undefined) selector = argument;
            else return unchanged; // A second positional argument is a prompt and must never be replayed.
            continue;
        }
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (VALUE_OPTIONS.has(flag)) {
            const values = [argument];
            if (equals < 0) {
                if (++index >= command.length) return unchanged;
                values.push(command[index]);
            }
            retry.push(...values);
            if (CONFIG_OPTIONS.has(flag)) config.push(...values);
        } else if (SELECTOR_OPTIONS.has(argument) && resume) {
            // The failed picker/last selection is replaced by its validated UUID after recovery.
        } else if (BOOLEAN_OPTIONS.has(argument)) retry.push(argument);
        else return unchanged;
    }
    if (!resume) return unchanged;
    const plan: CodexResumeRecoveryPlan = { command: unchanged, retry, config, selector };
    try {
        const runtime = readFileSync(new URL("../dist/codex-resume-runtime.cjs", import.meta.url), "utf8");
        return ["node", "-e", runtime, "--", JSON.stringify(plan)];
    } catch {
        console.error("[ccc] Automatic resume recovery is unavailable; rebuild or reinstall CCC.");
        return unchanged;
    }
}
