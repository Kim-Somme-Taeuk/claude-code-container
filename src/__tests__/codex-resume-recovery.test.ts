import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCodexResumeRecoveryCommand } from "../codex-resume-recovery.js";

const id = "01a0eadb-e8b9-7a73-bc21-d39191b8dae5";
const otherId = "01a0eadb-e8b9-7a73-bc21-d39191b8dae6";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("automatic resume eligibility", () => {
    it.each([
        ["codex", "resume"], ["codex", "resume", id],
        ["codex", "--no-daemon", "resume", "--last"],
        ["codex", "resume", "--all", "--no-alt-screen"],
        ["codex", "-c", 'model="example"', "resume", id],
    ])("wraps local prompt-free resume: %j", (...args) => {
        expect(buildCodexResumeRecoveryCommand(args).slice(0, 2)).toEqual(["node", "-e"]);
    });

    it.each([
        ["claude", "resume"], ["codex"], ["codex", "exec", "prompt"],
        ["codex", "fork", id], ["codex", "doctor"],
        ["codex", "resume", id, "continue this work"],
        ["codex", "resume", id, "--image", "image.png"],
        ["codex", "resume", "--remote", "unix:///tmp/socket"],
        ["codex", "resume", "--remote=wss://example.invalid"],
        ["codex", "--profile", "profile-a", "resume"],
        ["codex", "resume", "--worktree"], ["codex", "resume", "--unknown-option"],
        ["codex", "resume", "--"], ["codex", "resume", "-c"],
        ["codex", "resume", "--help"],
    ])("preserves unsafe, noninteractive or unsupported invocations: %j", (...args) => {
        expect(buildCodexResumeRecoveryCommand(args)).toEqual(args);
    });
});

interface FixtureOptions {
    output?: "exact" | "quoted" | "nonfinal" | "other-error" | "large";
    firstExit?: number;
    firstSignal?: "SIGINT" | "SIGTERM" | "SIGHUP";
    retryExit?: number;
    retryFails?: boolean;
    help?: "unsupported";
    migration?: string;
    migrationExit?: number;
    reportedId?: string;
    pathScope?: "outside" | "symlink" | "archived" | "missing";
    noScript?: boolean;
    metadata?: "restore" | "wrong-home" | "wrong-path" | "rpc-error" | "unsupported" | "initialize-error" | "close-error";
}

function runFixture(args: string[] = ["codex", "resume", "--last"], options: FixtureOptions = {}) {
    const root = mkdtempSync(join(tmpdir(), "ccc-resume-recovery-test-"));
    roots.push(root);
    const home = join(root, "home with spaces");
    const bin = join(root, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    const filename = `rollout-2026-09-29T10-51-15-${options.reportedId || id}.jsonl`;
    const inside = join(home, options.pathScope === "archived" ? "archived_sessions" : "sessions", filename);
    mkdirSync(dirname(inside), { recursive: true });
    let rollout = inside;
    if (options.pathScope === "outside" || options.pathScope === "symlink") {
        const outside = join(root, filename);
        writeFileSync(outside, "fixture history\n");
        if (options.pathScope === "symlink") symlinkSync(outside, inside);
        else rollout = outside;
    } else if (options.pathScope !== "missing") writeFileSync(inside, "fixture history\n");
    const log = join(root, "calls.jsonl");
    const behavior = {
        ...options, rollout,
        migration: options.migration ?? JSON.stringify({ outcomes: [{ thread_id: id, status: "already_paginated" }] }),
    };
    writeFileSync(join(root, "behavior.json"), JSON.stringify(behavior));
    const fake = join(bin, "codex");
    writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.RECOVERY_TEST_ROOT;
const behavior = JSON.parse(fs.readFileSync(path.join(root,'behavior.json'),'utf8'));
const log = path.join(root,'calls.jsonl');
const args = process.argv.slice(2);
const prior = fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(log,JSON.stringify(args)+'\\n');
if(args[0] === 'app-server') {
 if(args.includes('--help')) {
  process.stdout.write(behavior.metadata === 'unsupported' ? 'unsupported' : 'Usage: codex app-server [OPTIONS]\\n--stdio\\n');
  process.exit(0);
 }
 let pending = '';
 process.stdin.setEncoding('utf8');
 process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while((end = pending.indexOf('\\n')) >= 0) {
   const message = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
   fs.appendFileSync(path.join(root,'rpc.jsonl'),JSON.stringify(message)+'\\n');
   if(message.method === 'initialize') process.stdout.write(JSON.stringify(behavior.metadata === 'initialize-error' ? {id:message.id,error:{code:-32603,message:'PRIVATE_CONVERSATION_PREVIEW'}} : {id:message.id,result:{codexHome:behavior.metadata === 'wrong-home' ? root : process.env.CODEX_HOME}})+'\\n');
   if(message.method === 'thread/read') {
    process.stdout.write(JSON.stringify({method:'remoteControl/status/changed',params:{}})+'\\n');
    const response = behavior.metadata === 'rpc-error'
     ? {id:message.id,error:{code:-32603,message:'PRIVATE_CONVERSATION_PREVIEW'}}
     : {id:message.id,result:{thread:{id:message.params.threadId,path:behavior.metadata === 'wrong-path' ? path.join(root,'wrong.jsonl') : behavior.rollout,preview:'PRIVATE_CONVERSATION_PREVIEW'}}};
    fs.writeFileSync(path.join(root,'metadata-restored'),'yes');
    process.stdout.write(JSON.stringify(response)+'\\n');
   }
  }
 });
 process.stdin.on('end', () => {
  if(behavior.metadata === 'close-error') process.stderr.write('PRIVATE_CONVERSATION_PREVIEW');
  process.exit(behavior.metadata === 'close-error' ? 1 : 0);
 });
} else {
if(args[0] === 'migrate-rollouts') {
 if(args.includes('--help')) {
  process.stdout.write(behavior.help === 'unsupported' ? 'unsupported' : 'Usage: codex migrate-rollouts [OPTIONS]\\n--apply --thread --json\\n');
  process.exit(0);
 }
 if(behavior.metadata && !fs.existsSync(path.join(root,'metadata-restored'))) {
  process.stderr.write('Error: thread-store internal error: rollout migration failed: thread ${id} is missing its SQLite metadata\\n');
  process.exit(1);
 }
 process.stdout.write(behavior.migration);
 process.exit(behavior.migrationExit ?? 0);
}
const attempt = prior.filter(a => a.includes('resume')).length;
if(attempt && !behavior.retryFails) {
 process.stdout.write('RESUMED EXACT SESSION\\n');
 process.exit(behavior.retryExit ?? 0);
}
const error = 'Error: Failed to resume session from '+behavior.rollout+': thread/resume failed during TUI bootstrap: thread/resume failed: list_turns is not supported yet (code -32601)';
if(behavior.output === 'large') process.stdout.write('x'.repeat(80000)+'\\n');
if(behavior.output === 'quoted') process.stderr.write('User quoted: '+error+'\\n');
else if(behavior.output === 'other-error') process.stderr.write('Error: authentication failed\\n');
else process.stderr.write(error+'\\n');
if(behavior.output === 'nonfinal') process.stderr.write('Error: unrelated later failure\\n');
if(behavior.firstSignal) { process.kill(process.pid, behavior.firstSignal); setTimeout(() => process.exit(99), 1000); }
else
process.exit(behavior.firstExit ?? 1);
}
`);
    chmodSync(fake, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, PATH: `${bin}:${process.env.PATH}`, RECOVERY_TEST_ROOT: root };
    if (options.noScript) {
        const preload = join(root, "no-script.cjs");
        writeFileSync(preload, `const cp=require('node:child_process');const original=cp.spawn;cp.spawn=function(file,args,options){if(file==='/usr/bin/script')return original.call(this,process.execPath,['-e','process.exit(1)'],options);return original.call(this,file,args,options)};`);
        env.NODE_OPTIONS = `--require=${preload}`;
    }
    const wrapped = buildCodexResumeRecoveryCommand(args);
    const result = spawnSync(wrapped[0], wrapped.slice(1), { env, cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    const calls: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const resumes = calls.filter(call => call.includes("resume"));
    const migrations = calls.filter(call => call[0] === "migrate-rollouts" && call.includes("--apply"));
    const rpcFile = join(root, "rpc.jsonl");
    const rpc = existsSync(rpcFile) ? readFileSync(rpcFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { result, calls, resumes, migrations, inside, root, rpc };
}

describe.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/script"))("executed automatic recovery wrapper", () => {
    it("repairs only the selected thread once and removes picker selectors on retry", () => {
        const args = ["codex", "--no-daemon", "resume", "--last", "--all", "--include-non-interactive", "--no-alt-screen"];
        const run = runFixture(args);
        expect(run.result.error).toBeUndefined();
        expect(run.result.status).toBe(0);
        expect(run.resumes).toEqual([args.slice(1), ["--no-daemon", "resume", "--no-alt-screen", id]]);
        expect(run.migrations).toEqual([["migrate-rollouts", "--apply", "--thread", id, "--json"]]);
        expect(readFileSync(run.inside, "utf8")).toBe("fixture history\n");
    });

    it("preserves literal shell metacharacters and config overrides without execution", () => {
        const config = 'test="space ; $(touch NEVER_CREATED) \'quoted\'"';
        const args = ["codex", "-c", config, "resume", id, "--model", "example-model"];
        const run = runFixture(args);
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.resumes).toEqual([args.slice(1), ["-c", config, "resume", "--model", "example-model", id]]);
        expect(run.migrations[0]).toEqual(["migrate-rollouts", "-c", config, "--apply", "--thread", id, "--json"]);
        expect(existsSync(join(run.root, "NEVER_CREATED"))).toBe(false);
    });

    it.each(["migrated", "already_paginated"])("accepts native %s for exactly the target", status => {
        const run = runFixture(undefined, { migration: JSON.stringify({ outcomes: [{ thread_id: id, status }] }) });
        expect(run.result.status).toBe(0);
        expect(run.resumes).toHaveLength(2);
    });

    it.each([
        "not json", JSON.stringify({}), JSON.stringify({ outcomes: [] }),
        ...["failed", "locked", "skipped"].map(status => JSON.stringify({ outcomes: [{ thread_id: id, status }] })),
        JSON.stringify({ outcomes: [{ thread_id: otherId, status: "migrated" }] }),
        JSON.stringify({ outcomes: [{ thread_id: id, status: "migrated" }, { thread_id: otherId, status: "migrated" }] }),
    ])("does not retry an unverified migration outcome: %s", migration => {
        const run = runFixture(undefined, { migration });
        expect(run.result.status).toBe(1);
        expect(run.resumes).toHaveLength(1);
        expect(run.migrations).toHaveLength(1);
    });

    it.each(["quoted", "nonfinal", "other-error"] as const)("does not repair %s diagnostics", output => {
        const run = runFixture(undefined, { output });
        expect(run.result.status).toBe(1);
        expect(run.calls).toHaveLength(1);
    });

    it.each([0, 2, 129, 130, 143])("does not repair exit %d even with matching text", firstExit => {
        const run = runFixture(undefined, { firstExit });
        expect(run.result.status).toBe(firstExit);
        expect(run.calls).toHaveLength(1);
    });

    it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)("does not repair a native %s interruption", (firstSignal, status) => {
        const run = runFixture(undefined, { firstSignal });
        expect(run.result.status).toBe(status);
        expect(run.calls).toHaveLength(1);
    });

    it.each(["outside", "symlink", "missing"] as const)("refuses %s rollout paths", pathScope => {
        const run = runFixture(undefined, { pathScope });
        expect(run.result.status).toBe(1);
        expect(run.migrations).toHaveLength(0);
    });

    it("refuses a reported UUID different from an explicitly requested session", () => {
        const run = runFixture(["codex", "resume", otherId]);
        expect(run.result.status).toBe(1);
        expect(run.migrations).toHaveLength(0);
        expect(run.resumes).toHaveLength(1);
    });

    it("supports existing archived rollouts", () => {
        expect(runFixture(undefined, { pathScope: "archived" }).result.status).toBe(0);
    });

    it("does not retry again when the repaired launch has the same failure", () => {
        const run = runFixture(undefined, { retryFails: true });
        expect(run.result.status).toBe(1);
        expect(run.resumes).toHaveLength(2);
        expect(run.migrations).toHaveLength(1);
    });

    it.each([{ help: "unsupported" }, { migrationExit: 1 }, { noScript: true }] as FixtureOptions[])("preserves failure without unsupported recovery: %j", options => {
        const run = runFixture(undefined, options);
        expect(run.result.status).toBe(1);
        expect(run.resumes).toHaveLength(1);
        expect(run.migrations).toHaveLength(options.migrationExit ? 1 : 0);
    });

    it("retains the final diagnostic after large live output and forwards all output", () => {
        const run = runFixture(undefined, { output: "large" });
        expect(run.result.status).toBe(0);
        expect(run.result.stdout.length).toBeGreaterThan(80000);
        expect(run.resumes).toHaveLength(2);
    });

    it("rejects oversized migration output instead of replaying resume", () => {
        const migration = JSON.stringify({ outcomes: [{ thread_id: id, status: "migrated" }], excess: "x".repeat(70000) });
        const run = runFixture(undefined, { migration });
        expect(run.result.status).toBe(1);
        expect(run.resumes).toHaveLength(1);
        expect(run.result.stderr.length).toBeLessThan(5000);
    });

    it("reconstructs missing metadata through one targeted native read before retrying migration", () => {
        const run = runFixture(undefined, { metadata: "restore" });
        expect(run.result.error).toBeUndefined();
        expect(run.result.status, run.result.stderr).toBe(0);
        expect(run.migrations).toHaveLength(2);
        expect(run.resumes).toHaveLength(2);
        expect(run.rpc.filter(message => message.method === "thread/read")).toEqual([
            expect.objectContaining({ params: { threadId: id, includeTurns: false } }),
        ]);
        expect(readFileSync(run.inside, "utf8")).toBe("fixture history\n");
        expect(run.result.stdout + run.result.stderr).not.toContain("PRIVATE_CONVERSATION_PREVIEW");
    });

    it.each([
        ["wrong-home", "Could not verify the Codex data directory", "metadata-home"],
        ["wrong-path", "Could not restore this session's metadata", "metadata-read"],
        ["rpc-error", "Could not restore this session's metadata", "metadata-read"],
        ["unsupported", "Codex metadata recovery is unavailable", "metadata-support"],
        ["initialize-error", "Could not verify the metadata server", "metadata-initialize"],
        ["close-error", "The metadata server did not finish cleanly", "metadata-close"],
    ] as const)("identifies metadata failure without exposing protocol data: %s", (metadata, explanation, stage) => {
        const run = runFixture(undefined, { metadata });
        expect(run.result.error).toBeUndefined();
        expect(run.result.status).toBe(1);
        expect(run.migrations).toHaveLength(1);
        expect(run.resumes).toHaveLength(1);
        if (metadata === "wrong-home") expect(run.rpc.some(message => message.method === "thread/read")).toBe(false);
        expect(run.result.stderr).toContain(`[ccc] ${explanation} (${stage}).\n`);
        expect(run.result.stdout + run.result.stderr).not.toContain("PRIVATE_CONVERSATION_PREVIEW");
    });

    it.each([false, true])("distinguishes migration failure after metadata=%s without replaying native output", afterMetadata => {
        const run = runFixture(undefined, {
            metadata: afterMetadata ? "restore" : undefined,
            migration: "PRIVATE_MIGRATION_OUTPUT",
            migrationExit: 1,
        });
        expect(run.result.error).toBeUndefined();
        expect(run.result.status).toBe(1);
        expect(run.migrations).toHaveLength(afterMetadata ? 2 : 1);
        expect(run.resumes).toHaveLength(1);
        expect(run.result.stderr).toBe("[ccc] Repairing this session's history index and resuming once.\n" + (afterMetadata
            ? "[ccc] Session migration failed after metadata recovery (migration-after-metadata).\n"
            : "[ccc] Session migration failed (migration).\n"));
        expect(run.result.stdout + run.result.stderr).not.toMatch(/PRIVATE_MIGRATION_OUTPUT|PRIVATE_CONVERSATION_PREVIEW/);
    });
});
