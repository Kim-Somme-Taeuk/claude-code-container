import { realpathSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ResumeProcessResult } from "./codex-resume-process.js";

export interface FailedResumeRollout { id: string; path: string }

/** Accept only the final native bootstrap error for a rollout inside this Codex home. */
export function failedResumeRollout(output: string, home: string, selector?: string): FailedResumeRollout | null {
    // Codex resets the cursor before its final error without necessarily printing a newline.
    const text = stripVTControlCharacters(output.replace(/\x1b\[0 q/g, "\n")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).trimEnd();
    const finalLine = text.slice(text.lastIndexOf("\n") + 1);
    const match = /^Error: Failed to resume session from (\/[^\r\n]+): thread\/resume failed during TUI bootstrap: thread\/resume failed: list_turns is not supported yet \(code -32601\)$/.exec(finalLine);
    if (!match) return null;
    const filename = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(match[1]));
    if (!filename) return null;
    if (selector && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
        && selector.toLowerCase() !== filename[1].toLowerCase()) return null;
    try {
        const file = realpathSync(match[1]);
        const relativePath = relative(realpathSync(home), file);
        if (!/^(sessions|archived_sessions)\//.test(relativePath) || !statSync(file).isFile()) return null;
        if (basename(file) !== basename(match[1])) return null;
        return { id: filename[1].toLowerCase(), path: file };
    } catch {
        return null;
    }
}

export function supportsRolloutMigration(help: ResumeProcessResult): boolean {
    return help.code === 0 && !help.signal && !help.overflow
        && /Usage:\s+\S+\s+migrate-rollouts\b/.test(help.output)
        && ["--apply", "--thread", "--json"].every(flag => help.output.includes(flag));
}

export function migrationRepairedThread(output: string, id: string): boolean {
    try {
        const result: unknown = JSON.parse(output);
        if (!result || typeof result !== "object" || !("outcomes" in result)
            || !Array.isArray(result.outcomes) || result.outcomes.length !== 1) return false;
        const outcome: unknown = result.outcomes[0];
        return outcome !== null && typeof outcome === "object"
            && "thread_id" in outcome && outcome.thread_id === id
            && "status" in outcome && (outcome.status === "migrated" || outcome.status === "already_paginated");
    } catch {
        return false;
    }
}

export function failedResumeThread(output: string, home: string, selector?: string): string | null {
    return failedResumeRollout(output, home, selector)?.id ?? null;
}

export function missingResumeMetadata(result: ResumeProcessResult, id: string): boolean {
    if (result.code !== 1 || result.signal || result.overflow) return false;
    const text = stripVTControlCharacters(result.stderr || result.output).trimEnd();
    return text.slice(text.lastIndexOf("\n") + 1)
        === `Error: thread-store internal error: rollout migration failed: thread ${id} is missing its SQLite metadata`;
}
