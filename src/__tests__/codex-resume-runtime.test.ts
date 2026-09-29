import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { failedResumeThread, migrationRepairedThread, supportsRolloutMigration } from "../codex-resume-diagnostics.js";
import { createResumeProcessRunner, terminalResumeCommand, type ResumeProcessResult, type ResumeProcessRunner } from "../codex-resume-process.js";
import { runCodexResumeRecovery, type CodexResumeRecoveryPlan } from "../codex-resume-recovery-runtime.js";

const id = "01a0eadb-e8b9-7a73-bc21-d39191b8dae5";
const otherId = "01a0eadb-e8b9-7a73-bc21-d39191b8dae6";
const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(archive = false) {
    const root = mkdtempSync(join(tmpdir(), "ccc-resume-unit-"));
    roots.push(root);
    const home = join(root, "codex home");
    const dir = join(home, archive ? "archived_sessions" : "sessions", "2026", "09", "29");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-09-29T10-51-15-${id}.jsonl`);
    writeFileSync(file, "fixture history\n");
    return { root, home, file, dir };
}

function diagnostic(file: string) {
    return `Error: Failed to resume session from ${file}: thread/resume failed during TUI bootstrap: thread/resume failed: list_turns is not supported yet (code -32601)`;
}
function result(overrides: Partial<ResumeProcessResult> = {}): ResumeProcessResult {
    return { code: 0, output: "", stderr: "", overflow: false, signal: null, ...overrides };
}
function outcome(status = "already_paginated", thread = id) {
    return JSON.stringify({ outcomes: [{ thread_id: thread, status }] });
}
const help = result({ output: "Usage: codex migrate-rollouts [OPTIONS]\n--apply --thread --json\n" });

// Native recovery runs inside the Linux container and reports POSIX rollout paths.
describe.skipIf(process.platform === "win32")("typed recovery path diagnostics", () => {
    it.each([false, true])("identifies only an existing scoped rollout (archived=%s)", archive => {
        const { home, file } = fixture(archive);
        expect(failedResumeThread(diagnostic(file), home)).toBe(id);
        expect(failedResumeThread(diagnostic(file), home, id.toUpperCase())).toBe(id);
        expect(failedResumeThread(diagnostic(file), home, otherId)).toBeNull();
    });

    it("recognizes native cursor teardown without allowing a quoted historical error", () => {
        const { home, file } = fixture();
        expect(failedResumeThread(`TUI content\u001b[0 q\u001b[?25h${diagnostic(file)}\r\n`, home)).toBe(id);
        expect(failedResumeThread(`Quoted historical ${diagnostic(file)}\n`, home)).toBeNull();
        expect(failedResumeThread(`${diagnostic(file)}\nError: unrelated later failure\n`, home)).toBeNull();
        expect(failedResumeThread(diagnostic(file).replace("-32601", "-32000"), home)).toBeNull();
    });

    it("rejects missing paths, directories, out-of-home files and symlink escapes", () => {
        const { home, file, root, dir } = fixture();
        const outside = join(root, `rollout-test-${id}.jsonl`);
        writeFileSync(outside, "outside fixture");
        expect(failedResumeThread(diagnostic(outside), home)).toBeNull();
        expect(failedResumeThread(diagnostic(join(dir, `rollout-missing-${id}.jsonl`)), home)).toBeNull();
        rmSync(file);
        mkdirSync(file);
        expect(failedResumeThread(diagnostic(file), home)).toBeNull();
        rmSync(file, { recursive: true });
        if (process.platform !== "win32") {
            symlinkSync(outside, file);
            expect(failedResumeThread(diagnostic(file), home)).toBeNull();
        }
    });

});

describe("typed recovery response diagnostics", () => {
    it.each(["migrated", "already_paginated"])("accepts exactly one matching %s outcome", status => {
        expect(migrationRepairedThread(outcome(status), id)).toBe(true);
    });

    it.each([
        "not JSON", "null", "{}", JSON.stringify({ outcomes: [] }),
        outcome("failed"), outcome("locked"), outcome("skipped"), outcome("migrated", otherId),
        JSON.stringify({ outcomes: [{ thread_id: id, status: "migrated" }, { thread_id: id, status: "migrated" }] }),
    ])("rejects incomplete or unscoped migration results: %s", output => {
        expect(migrationRepairedThread(output, id)).toBe(false);
    });

    it("requires supported migration flags and a complete successful help response", () => {
        expect(supportsRolloutMigration(help)).toBe(true);
        for (const flag of ["--apply", "--thread", "--json"]) {
            expect(supportsRolloutMigration({ ...help, output: help.output.replace(flag, "") })).toBe(false);
        }
        for (const extra of [{ code: 1 }, { overflow: true }, { signal: "SIGTERM" as const }]) {
            expect(supportsRolloutMigration({ ...help, ...extra })).toBe(false);
        }
        expect(supportsRolloutMigration(result({ output: "--apply --thread --json" }))).toBe(false);
    });
});

type Step = ResumeProcessResult | Error | { interrupt: number; response: ResumeProcessResult };
function scriptedRunner(steps: Step[]) {
    let interrupted = 0;
    const run = vi.fn<ResumeProcessRunner["run"]>().mockImplementation(async () => {
        const step = steps.shift();
        if (!step) throw new Error("unexpected extra process");
        if (step instanceof Error) throw step;
        if ("interrupt" in step) { interrupted = step.interrupt; return step.response; }
        return step;
    });
    const dispose = vi.fn();
    const runner: ResumeProcessRunner = { run, get interrupted() { return interrupted; }, dispose };
    return { runner, run, dispose };
}
function plan(): CodexResumeRecoveryPlan {
    return {
        command: ["codex", "--no-daemon", "resume", "--last", "-c", 'model="example"'],
        retry: ["codex", "--no-daemon", "resume", "-c", 'model="example"'],
        config: ["-c", 'model="example"'],
    };
}
function sequence(file: string): Step[] {
    return [result({ output: "script from util-linux 2.40" }), result({ code: 1, output: diagnostic(file) }), help, result({ output: outcome() }), result()];
}

describe.skipIf(process.platform === "win32")("typed recovery orchestration", () => {
    it("performs one scoped migration and one retry pinned to the failed UUID", async () => {
        const { home, file } = fixture();
        const { runner, run, dispose } = scriptedRunner(sequence(file));
        const report = vi.fn();
        expect(await runCodexResumeRecovery(plan(), runner, home, report)).toBe(0);
        expect(run).toHaveBeenCalledTimes(5);
        expect(run.mock.calls[1][0]).toEqual(terminalResumeCommand(plan().command));
        expect(run.mock.calls[3][0]).toEqual(["codex", "migrate-rollouts", "-c", 'model="example"', "--apply", "--thread", id, "--json"]);
        expect(run.mock.calls[3][1]?.timeoutMs).toBeGreaterThan(0);
        expect(run.mock.calls[4][0]).toEqual(terminalResumeCommand([...plan().retry, id]));
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalled();
    });

    it("falls back to exactly the original invocation when script is unavailable", async () => {
        const { home } = fixture();
        const { runner, run, dispose } = scriptedRunner([result({ code: 1 }), result({ code: 7 })]);
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(7);
        expect(run.mock.calls[1]).toEqual([plan().command, expect.objectContaining({ direct: true })]);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it.each([0, 2, 130, 143])("preserves exit %d without attempting repair", async code => {
        const { home, file } = fixture();
        const { runner, run, dispose } = scriptedRunner([result({ output: "util-linux" }), result({ code, output: diagnostic(file) })]);
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(code);
        expect(run).toHaveBeenCalledTimes(2);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it.each([0, 1, 2, 3])("stops between stages after interruption at stage %d", async stage => {
        const { home, file } = fixture();
        const steps = sequence(file).slice(0, stage + 1);
        steps[stage] = { interrupt: 143, response: steps[stage] as ResumeProcessResult };
        const { runner, run, dispose } = scriptedRunner(steps);
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(143);
        expect(run).toHaveBeenCalledTimes(stage + 1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it.each(["help", "migration", "retry"])("does not broaden or repeat recovery after %s failure", async stage => {
        const { home, file } = fixture();
        const steps = sequence(file);
        const index = stage === "help" ? 2 : stage === "migration" ? 3 : 4;
        steps[index] = result({ code: 1, output: diagnostic(file) });
        const { runner, run, dispose } = scriptedRunner(steps.slice(0, index + 1));
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(1);
        expect(run).toHaveBeenCalledTimes(index + 1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("bounds a failed migration diagnostic", async () => {
        const { home, file } = fixture();
        const steps = sequence(file).slice(0, 4);
        steps[3] = result({ code: 1, stderr: "x".repeat(10000) });
        const { runner } = scriptedRunner(steps);
        const report = vi.fn();
        expect(await runCodexResumeRecovery(plan(), runner, home, report)).toBe(1);
        expect(report.mock.calls.map(call => String(call[0])).join("").length).toBeLessThan(2500);
    });

    it.each([
        { overflow: true }, { signal: "SIGTERM" as const },
        { output: outcome("locked") }, { output: outcome("migrated", otherId) },
    ])("refuses a nominally zero-exit migration with invalid completion: %j", async completion => {
        const { home, file } = fixture();
        const steps = sequence(file).slice(0, 4);
        steps[3] = result({ output: outcome(), ...completion });
        const { runner, run, dispose } = scriptedRunner(steps);
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(1);
        expect(run).toHaveBeenCalledTimes(4);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("does not advance from an unrelated terminal error", async () => {
        const { home } = fixture();
        const { runner, run, dispose } = scriptedRunner([result({ output: "util-linux" }), result({ code: 1, output: "Error: unauthorized" })]);
        expect(await runCodexResumeRecovery(plan(), runner, home, vi.fn())).toBe(1);
        expect(run).toHaveBeenCalledTimes(2);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("disposes the runner when a subprocess promise rejects", async () => {
        const { home } = fixture();
        const { runner, dispose } = scriptedRunner([new Error("spawn failure")]);
        await expect(runCodexResumeRecovery(plan(), runner, home, vi.fn())).rejects.toThrow("spawn failure");
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});

describe("typed real process runner", () => {
    it("captures normal output and preserves the child exit status", async () => {
        const runner = createResumeProcessRunner();
        try {
            expect(await runner.run([process.execPath, "-e", "process.stdout.write('out');process.stderr.write('err');process.exitCode=7"])).toEqual(result({ code: 7, output: "out", stderr: "err" }));
        } finally { runner.dispose(); }
    });

    it("bounds a timed-out child and an oversized capture", async () => {
        const runner = createResumeProcessRunner();
        try {
            const timed = await runner.run([process.execPath, "-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 });
            expect(timed.code).not.toBe(0);
            expect(timed.overflow).toBe(true);
            const large = await runner.run([process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"]);
            expect(large.overflow).toBe(true);
            expect(Buffer.byteLength(large.output)).toBeLessThanOrEqual(65536);
        } finally { runner.dispose(); }
    });

    it("retains a bounded terminal tail while forwarding the complete output", async () => {
        const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        const runner = createResumeProcessRunner();
        try {
            const output = await runner.run([process.execPath, "-e", "process.stdout.write('x'.repeat(80000)+'TAIL')"], { terminal: true });
            expect(output.code).toBe(0);
            expect(output.overflow).toBe(false);
            expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(16384);
            expect(output.output.endsWith("TAIL")).toBe(true);
            expect(write.mock.calls.reduce((bytes, call) => bytes + Buffer.byteLength(call[0]), 0)).toBe(80004);
        } finally { runner.dispose(); }
    });

    it("returns a finite failure for a missing executable", async () => {
        const runner = createResumeProcessRunner();
        try {
            const output = await runner.run([join(tmpdir(), "ccc-executable-does-not-exist", "missing")]);
            expect(output.code).not.toBe(0);
            expect(output.signal).toBeNull();
        } finally { runner.dispose(); }
    });

    it("removes its signal listeners on disposal, including repeated disposal", () => {
        const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGWINCH"] as const;
        const before = signals.map(signal => process.listenerCount(signal));
        const runner = createResumeProcessRunner();
        runner.dispose();
        runner.dispose();
        expect(signals.map(signal => process.listenerCount(signal))).toEqual(before);
    });
});
