import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Children load exactly the coordinator-built distribution, without tsx or
// Vitest aliases. SIGKILL cleanup and native Windows console events are outside
// this contract; ordinary explicit exit/disposal run on every platform.
const moduleUrl = (name: string) => JSON.stringify(new URL(`../../dist/${name}.js`, import.meta.url).href);
const marker = "GENERATED_NONSECRET_SESSION_ENV_MARKER";
interface RuntimeIdentity { pid: number; token?: string }
interface Fixture {
    child: ChildProcess;
    messages: Record<string, unknown>[];
    output: string;
    stdout: string;
    closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    ended: boolean;
    runtime?: RuntimeIdentity;
}

async function until(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for owned fixture ${description}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function startToken(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        return fields[0] !== "Z" && fields[0] !== "X" ? fields[19] : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function runtimeAlive(identity: RuntimeIdentity): boolean {
    if (process.platform === "linux") return identity.token !== undefined && startToken(identity.pid) === identity.token;
    try { process.kill(identity.pid, 0); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
}

describe("emitted owned environment file process lifetime", () => {
    let root: string;
    let home: string;
    let temporary: string;
    const fixtures: Fixture[] = [];

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-env-lifetime-"));
        home = join(root, "home");
        temporary = join(root, "tmp");
        mkdirSync(home);
        mkdirSync(temporary);
    });

    afterEach(async () => {
        try {
            for (const fixture of fixtures) {
                // A returned ChildProcess handle is owned by this test. No
                // process groups, name searches, CCC queries or global kills.
                if (!fixture.ended) {
                    if (process.platform !== "win32") fixture.child.kill("SIGTERM");
                    else fixture.child.kill();
                    await until(() => fixture.ended, "parent teardown").catch(() => {
                        fixture.child.kill("SIGKILL");
                    });
                }
                if (fixture.runtime && runtimeAlive(fixture.runtime)) {
                    // Linux provides a native PID generation token; never
                    // signal a bare possibly recycled grandchild PID.
                    if (process.platform === "linux" && startToken(fixture.runtime.pid) === fixture.runtime.token) {
                        process.kill(fixture.runtime.pid, "SIGKILL");
                    } else {
                        // The runtime owns inherited stdin. Closing our exact
                        // pipe is its portable teardown rendezvous.
                        fixture.child.stdin?.end();
                    }
                    await until(() => !runtimeAlive(fixture.runtime!), "runtime teardown");
                }
                await until(() => fixture.ended, "parent joined");
                await fixture.closed;
            }
        } finally {
            fixtures.length = 0;
            rmSync(root, { recursive: true, force: true });
        }
    });

    function launch(mode: "exit" | "dispose" | "replacement" | "signal" | "closed-stderr", status: number): Fixture {
        const runtimeScript = join(root, "runtime.mjs");
        writeFileSync(runtimeScript, `
import {readFileSync} from 'node:fs';
const stat = process.platform === 'linux' ? readFileSync('/proc/' + process.pid + '/stat', 'utf8') : undefined;
const token = stat?.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19];
process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
console.log(JSON.stringify({event:'runtime-ready',pid:process.pid,token}));
`);
        const source = `
import {writeOwnedEnvFile} from ${moduleUrl("utils")};
import {setupSignalHandlers} from ${moduleUrl("session")};
import {runContainerCommand} from ${moduleUrl("container-command")};
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,renameSync,writeFileSync,existsSync,statSync} from 'node:fs';
// Initialize the actual pipe stream before the parent closes its reading end.
const stderrStream = process.stderr;
const baseline = process.listenerCount('exit');
const owned = writeOwnedEnvFile([['CCC_TEST_MARKER',${JSON.stringify(marker)}]]);
const ready = {event:'ready',path:owned.path,baseline,listeners:process.listenerCount('exit')};
process.exitCode = ${status};
setupSignalHandlers(); // Empty session: no providers, claims or runtime cleanup queries.
if (${JSON.stringify(mode)} === 'signal') {
    process.send(ready);
    await runContainerCommand(process.execPath,[${JSON.stringify(runtimeScript)}],true);
    process.send({event:'unexpected-command-return'});
} else {
    process.send(ready);
    process.once('message', () => {
        if (${JSON.stringify(mode)} === 'closed-stderr') {
            const original = fs.lstatSync;
            fs.lstatSync = () => { throw Object.assign(new Error('fixture cleanup failure'), {code:'EACCES'}); };
            syncBuiltinESMExports();
            try { owned.dispose(); }
            finally { fs.lstatSync = original; syncBuiltinESMExports(); }
            console.log('stdout-after-disposal');
            // Natural exit lets queued stream errors run. An immediate
            // process.exit would conceal the old asynchronous EPIPE failure.
            process.disconnect();
            return;
        }
        if (${JSON.stringify(mode)} === 'dispose') {
            owned.dispose();
            const removed = !existsSync(owned.path);
            const listeners = process.listenerCount('exit');
            writeFileSync(owned.path,${JSON.stringify(marker)}, {flag:'wx'});
            owned.dispose();
            process.send({event:'disposed',removed,listeners,survived:existsSync(owned.path)}, () => process.exit(${status}));
            return;
        }
        if (${JSON.stringify(mode)} === 'replacement') {
            const bytes = readFileSync(owned.path);
            const retired = owned.path + '.retired';
            renameSync(owned.path,retired);
            writeFileSync(owned.path,bytes,{flag:'wx'});
            process.send({event:'replaced',retired,oldInode:statSync(retired).ino,newInode:statSync(owned.path).ino}, () => process.exit(${status}));
            return;
        }
        process.exit(${status});
    });
}
`;
        const script = join(root, "owner.mjs");
        writeFileSync(script, source);
        const child = spawn(process.execPath, [script], {
            env: {
                HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
                MISE_DISABLE: "1",
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            },
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        const fixture: Fixture = { child, messages: [], output: "", stdout: "", ended: false, closed: Promise.resolve({ code: null, signal: null }) };
        child.on("message", message => fixture.messages.push(message as Record<string, unknown>));
        child.stdout!.on("data", data => {
            fixture.output += String(data);
            fixture.stdout += String(data);
            for (const line of fixture.output.split("\n")) {
                if (line.startsWith('{"event":"runtime-ready"')) {
                    try { fixture.runtime = JSON.parse(line) as RuntimeIdentity; }
                    catch { /* Wait for the complete readiness line. */ }
                }
            }
        });
        child.stderr!.on("data", data => { fixture.output += String(data); });
        fixture.closed = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => { fixture.ended = true; resolve({ code, signal }); });
        });
        void fixture.closed.catch(() => undefined);
        fixtures.push(fixture);
        return fixture;
    }

    async function ready(fixture: Fixture): Promise<Record<string, unknown>> {
        await until(() => fixture.messages.some(message => message.event === "ready") || fixture.ended, "creation barrier");
        const message = fixture.messages.find(message => message.event === "ready");
        expect(message, fixture.output).toBeDefined();
        expect(message!.listeners).toBe(Number(message!.baseline) + 1);
        expect(readFileSync(String(message!.path), "utf8")).toBe(`CCC_TEST_MARKER=${marker}\n`);
        expect(String(message!.path).startsWith(temporary)).toBe(true);
        return message!;
    }

    async function joined(fixture: Fixture): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
        await until(() => fixture.ended, "completed parent exit");
        return fixture.closed;
    }

    it.each([0, 37])("removes an active file at real explicit process.exit(%s)", async status => {
        const fixture = launch("exit", status);
        const message = await ready(fixture);
        fixture.child.send({ event: "exit" });
        expect(await joined(fixture)).toEqual({ code: status, signal: null });
        expect(existsSync(String(message.path))).toBe(false);
    }, 15_000);

    it("explicit disposal unregisters and remains terminal through repeated disposal and exit", async () => {
        const fixture = launch("dispose", 29);
        const message = await ready(fixture);
        fixture.child.send({ event: "dispose" });
        expect(await joined(fixture)).toEqual({ code: 29, signal: null });
        expect(fixture.messages.find(item => item.event === "disposed")).toEqual({
            event: "disposed", removed: true, listeners: message.baseline, survived: true,
        });
        expect(readFileSync(String(message.path), "utf8")).toBe(marker);
    }, 15_000);

    it("preserves an identical-byte same-path successor and the retired original inode on exit", async () => {
        const fixture = launch("replacement", 31);
        const message = await ready(fixture);
        fixture.child.send({ event: "replace" });
        expect(await joined(fixture)).toEqual({ code: 31, signal: null });
        const replaced = fixture.messages.find(item => item.event === "replaced")!;
        expect(replaced).toBeDefined();
        expect(replaced.newInode).not.toBe(replaced.oldInode);
        expect(statSync(String(message.path)).ino).toBe(replaced.newInode);
        expect(statSync(String(replaced.retired)).ino).toBe(replaced.oldInode);
        expect(readFileSync(String(message.path))).toEqual(readFileSync(String(replaced.retired)));
    }, 15_000);

    // This fixture proves the Linux pipe EPIPE behavior. Native Windows pipe
    // and console-close behavior require separate platform evidence.
    it.skipIf(process.platform !== "linux")("a real closed stderr pipe cannot replace chosen status after cleanup failure", async () => {
        const fixture = launch("closed-stderr", 37);
        const message = await ready(fixture);
        const stderr = fixture.child.stderr!;
        const pipeClosed = new Promise<void>(resolve => stderr.once("close", resolve));
        stderr.destroy();
        await pipeClosed;
        fixture.child.send({ event: "dispose-with-closed-stderr" });
        expect(await joined(fixture)).toEqual({ code: 37, signal: null });
        expect(fixture.stdout).toBe("stdout-after-disposal\n");
        // The controlled lstat failure cannot authorize deletion. Only the
        // test's private root teardown removes the retained generated marker.
        expect(readFileSync(String(message.path), "utf8")).toBe(`CCC_TEST_MARKER=${marker}\n`);
    }, 15_000);

    describe.skipIf(process.platform === "win32")("handled POSIX signals during pending emitted launch", () => {
        it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("%s retires the exact owned runtime and env file while preserving exitCode", async signal => {
            const fixture = launch("signal", 43);
            const message = await ready(fixture);
            await until(() => fixture.runtime !== undefined || fixture.ended, "runtime readiness");
            expect(fixture.runtime, fixture.output).toBeDefined();
            const runtime = fixture.runtime!;
            if (process.platform === "linux") {
                expect(runtime.token).toMatch(/^\d+$/);
                expect(startToken(runtime.pid)).toBe(runtime.token);
            }
            expect(runtimeAlive(runtime)).toBe(true);
            expect(fixture.child.kill(signal)).toBe(true);
            expect(await joined(fixture)).toEqual({ code: 43, signal: null });
            await until(() => !runtimeAlive(runtime), "owned runtime exit");
            expect(existsSync(String(message.path))).toBe(false);
            expect(fixture.messages.some(item => item.event === "unexpected-command-return")).toBe(false);
        }, 15_000);
    });
});
