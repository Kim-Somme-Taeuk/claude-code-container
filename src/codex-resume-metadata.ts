import { realpathSync } from "node:fs";
import type { FailedResumeRollout } from "./codex-resume-diagnostics.js";
import type { ResumeProcessRunner, ResumeStdinAction } from "./codex-resume-process.js";

export type ResumeMetadataFailureStage =
    | "metadata-support" | "metadata-home" | "metadata-initialize" | "metadata-read" | "metadata-close";

export type ResumeMetadataResult = { ok: true } | { ok: false; stage: ResumeMetadataFailureStage };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Ask native Codex to restore only the missing thread index, without reading its turns. */
export async function restoreResumeMetadata(
    command: string,
    config: readonly string[],
    rollout: FailedResumeRollout,
    home: string,
    runner: ResumeProcessRunner,
): Promise<ResumeMetadataResult> {
    const help = await runner.run([command, "app-server", "--help"], { timeoutMs: 5000 });
    if (runner.interrupted || help.code !== 0 || help.signal || help.overflow
        || !/Usage:\s+\S+\s+app-server\b/.test(help.output) || !help.output.includes("--stdio")) {
        return { ok: false, stage: "metadata-support" };
    }
    let canonicalHome: string;
    try { canonicalHome = realpathSync(home); } catch { return { ok: false, stage: "metadata-home" }; }
    let stage: "initialize" | "read" | "done" = "initialize";
    let valid = true;
    let failureStage: ResumeMetadataFailureStage | undefined;
    const initialize = {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "ccc-resume-recovery", version: "1" }, capabilities: { experimentalApi: true } },
    };
    const result = await runner.run([command, "app-server", ...config, "--stdio"], {
        timeoutMs: 15000,
        input: JSON.stringify(initialize) + "\n",
        onStdoutLine(line): ResumeStdinAction | void {
            try {
                const message: unknown = JSON.parse(line);
                if (!record(message)) throw new Error();
                if (!("id" in message)) {
                    if (typeof message.method === "string" && message.method.length > 0 && !("result" in message) && !("error" in message)) return;
                    throw new Error();
                }
                if ("method" in message || "error" in message || !record(message.result)) throw new Error();
                if (stage === "initialize" && message.id === 1) {
                    if (typeof message.result.codexHome !== "string") throw new Error();
                    failureStage = "metadata-home";
                    if (realpathSync(message.result.codexHome) !== canonicalHome) throw new Error();
                    failureStage = undefined;
                    stage = "read";
                    return { input: JSON.stringify({ method: "initialized", params: {} }) + "\n"
                        + JSON.stringify({ id: 2, method: "thread/read", params: { threadId: rollout.id, includeTurns: false } }) + "\n" };
                }
                if (stage === "read" && message.id === 2) {
                    const thread = message.result.thread;
                    if (!record(thread) || thread.id !== rollout.id || typeof thread.path !== "string"
                        || realpathSync(thread.path) !== rollout.path) throw new Error();
                    stage = "done";
                    return { closeInput: true };
                }
                throw new Error();
            } catch {
                valid = false;
                throw new Error("Invalid Codex metadata response");
            }
        },
    });
    const finalStage = stage as string; // Updated by the stdout callback while the runner is awaited.
    if (!runner.interrupted && result.code === 0 && !result.signal && !result.overflow
        && valid && finalStage === "done") return { ok: true };
    return {
        ok: false,
        stage: failureStage ?? (finalStage === "done" ? "metadata-close"
            : finalStage === "read" ? "metadata-read" : "metadata-initialize"),
    };
}
