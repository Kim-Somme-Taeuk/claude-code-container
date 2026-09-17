import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { withSharedMutationLock } from "../device-lab-shared-state.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../utils.js", () => ({ getCodexConfigFile: () => join(state.home, ".ccc", "codex", "config.toml") }));
vi.mock("fs", async (original) => {
    const fs = await original<typeof import("fs")>();
    return { ...fs, lstatSync: vi.fn(fs.lstatSync), renameSync: vi.fn(fs.renameSync) };
});
const realFs = await vi.importActual<typeof import("fs")>("fs");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const owners: Array<{ child: ChildProcess; exit: Promise<{ code: number | null; stderr: string }> }> = [];
let lock: string;

beforeEach(() => {
    vi.stubEnv("container", "");
    state.home = mkdtempSync(join(tmpdir(), "ccc-codex-lock-"));
    mkdirSync(join(state.home, ".ccc"));
    lock = join(state.home, ".ccc", "codex-config.lock");
    vi.mocked(lstatSync).mockReset().mockImplementation(realFs.lstatSync);
    vi.mocked(renameSync).mockReset().mockImplementation(realFs.renameSync);
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const { child } of owners) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(owners.splice(0).map(({ exit }) => exit));
    rmSync(state.home, { recursive: true, force: true });
});

function writeStale(contents: string): void {
    writeFileSync(lock, contents, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
}

function childEnvironment(container: string): NodeJS.ProcessEnv {
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "VITEST" && !key.startsWith("VITEST_"))),
        container,
    };
}

function startOwner() {
    const ready = join(state.home, "owner-ready");
    const release = join(state.home, "owner-release");
    const script = `
        import fs from "fs";
        import os from "os";
        import { join } from "path";
        import { syncBuiltinESMExports } from "module";
        const [fixtureHome, moduleUrl] = process.argv.slice(1);
        os.homedir = () => fixtureHome;
        syncBuiltinESMExports();
        const { withCodexConfigLock } = await import(moduleUrl);
        withCodexConfigLock(() => {
            fs.writeFileSync(join(fixtureHome, "owner-ready"), fs.readFileSync(join(fixtureHome, ".ccc", "codex-config.lock")));
            const deadline = Date.now() + 10_000;
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(join(fixtureHome, "owner-release"))) {
                if (Date.now() >= deadline) throw new Error("Timed out waiting for owner release");
                Atomics.wait(sleeper, 0, 0, 10);
            }
        });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
        state.home, new URL("../codex-config-lock.ts", import.meta.url).href], {
        stdio: ["ignore", "ignore", "pipe"], env: childEnvironment(""), windowsHide: true,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        child.on("error", (error) => resolve({ code: -1, stderr: error.message }));
        child.on("close", (code) => resolve({ code, stderr }));
    });
    owners.push({ child, exit });
    const deadline = performance.now() + 8000;
    while (!existsSync(ready)) {
        if (performance.now() >= deadline) throw new Error("Timed out waiting for Codex lock owner");
        Atomics.wait(sleeper, 0, 0, 10);
    }
    return { release, exit, record: readFileSync(ready, "utf8"), inode: realFs.lstatSync(lock).ino };
}

it("refuses nested mutation of the same physical config while the host holds its lock and after release", async () => {
    const configDir = join(state.home, ".ccc", "codex");
    const config = join(configDir, "config.toml");
    const nestedHome = join(state.home, "nested");
    mkdirSync(configDir);
    mkdirSync(nestedHome);
    writeFileSync(config, "host config\n");
    // Model the credential bind mount while retaining separate host/nested homes.
    symlinkSync(configDir, join(nestedHome, ".codex"), "junction");
    const script = `
        import fs from "fs";
        import os from "os";
        import { syncBuiltinESMExports } from "module";
        const [fixtureHome, moduleUrl] = process.argv.slice(1);
        os.homedir = () => fixtureHome;
        const openedLocks = [];
        const openSync = fs.openSync;
        fs.openSync = (file, ...args) => {
            if (String(file).endsWith("codex-config.lock")) openedLocks.push(String(file));
            return openSync(file, ...args);
        };
        syncBuiltinESMExports();
        const { withCodexConfigLock } = await import(moduleUrl);
        const { getCodexConfigFile } = await import(new URL("./utils.ts", moduleUrl).href);
        const config = getCodexConfigFile();
        let invoked = false;
        let failure;
        try {
            withCodexConfigLock(() => {
                invoked = true;
                fs.writeFileSync(config, "nested mutation\\n");
            });
        } catch (error) {
            failure = error.message;
        }
        console.log(JSON.stringify({ config, realConfig: fs.realpathSync(config), openedLocks, invoked, failure }));
    `;
    const attemptNestedMutation = () => {
        const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script,
            nestedHome, new URL("../codex-config-lock.ts", import.meta.url).href], {
            encoding: "utf8", env: childEnvironment("docker"), timeout: 5000, windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
            config: join(nestedHome, ".codex", "config.toml"),
            realConfig: realFs.realpathSync(config),
            openedLocks: [],
            invoked: false,
            failure: expect.stringMatching(/run CCC from the host shell/i),
        });
        expect(readFileSync(config, "utf8")).toBe("host config\n");
        expect(readdirSync(nestedHome)).toEqual([".codex"]);
    };
    const owner = startOwner();
    const originalLock = realFs.lstatSync(lock);

    attemptNestedMutation();
    expect(readFileSync(lock, "utf8")).toBe(owner.record);
    expect(realFs.lstatSync(lock)).toMatchObject({
        ino: originalLock.ino, dev: originalLock.dev, mtimeMs: originalLock.mtimeMs,
    });
    writeFileSync(owner.release, "release");
    expect(await owner.exit).toEqual({ code: 0, stderr: "" });
    expect(existsSync(lock)).toBe(false);

    attemptNestedMutation();
    expect(existsSync(lock)).toBe(false);
});

it.each(["abandoned", "malformed"])("refuses an old %s Codex lock without modifying it or running the operation", (kind) => {
    const contents = kind === "abandoned"
        ? JSON.stringify({ token: "abandoned", pid: process.pid, host: hostname(), bootId: "previous-boot" })
        : "{incomplete";
    writeStale(contents);
    const before = realFs.lstatSync(lock);
    const operation = vi.fn();
    let failure: unknown;
    try { withCodexConfigLock(operation); } catch (error) { failure = error; }

    expect(failure).toMatchObject({ code: "shared-mutation-lock-stale" });
    expect((failure as Error).message).toContain(lock);
    expect((failure as Error).message).toMatch(/close other CCC sessions/i);
    expect((failure as Error).message).toMatch(/remove only this lock file/i);
    expect(operation).not.toHaveBeenCalled();
    expect(readFileSync(lock, "utf8")).toBe(contents);
    expect(realFs.lstatSync(lock)).toMatchObject({ ino: before.ino, dev: before.dev, mtimeMs: before.mtimeMs });
    expect(renameSync).not.toHaveBeenCalled();
    expect(readdirSync(join(state.home, ".ccc"))).toEqual(["codex-config.lock"]);
});

it("releases the Codex lock on success and preserves an operation's error on failure", () => {
    expect(withCodexConfigLock(() => {
        expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ pid: process.pid, host: hostname() });
        return "done";
    })).toBe("done");
    expect(existsSync(lock)).toBe(false);
    const failure = new Error("operation failed");
    expect(() => withCodexConfigLock(() => { throw failure; })).toThrow(failure);
    expect(existsSync(lock)).toBe(false);
});

it("waits for a live Codex owner to release before entering", async () => {
    const owner = startOwner();
    let observedContention = false;
    vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
        const stat = realFs.lstatSync(...args);
        if (args[0] === lock && !observedContention) {
            observedContention = true;
            expect(readFileSync(lock, "utf8")).toBe(owner.record);
            writeFileSync(owner.release, "release");
        }
        return stat;
    });

    expect(withCodexConfigLock(() => {
        expect(observedContention).toBe(true);
        const current = JSON.parse(readFileSync(lock, "utf8"));
        expect(current.pid).toBe(process.pid);
        expect(current.token).not.toBe(JSON.parse(owner.record).token);
        return "serialized";
    })).toBe("serialized");
    expect(await owner.exit).toEqual({ code: 0, stderr: "" });
    expect(existsSync(lock)).toBe(false);
});

it.each(["abandoned", "malformed"])("does not displace an owner that acquires after observing a %s Codex lock", async (kind) => {
    writeStale(kind === "abandoned"
        ? JSON.stringify({ token: "abandoned", pid: process.pid, host: hostname(), bootId: "previous-boot" })
        : "{incomplete");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let reads = 0;
    let owner: ReturnType<typeof startOwner> | undefined;
    vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
        const stat = realFs.lstatSync(...args);
        // The first stat validates readLock's inode. The second observes its age;
        // replace the stale record after that observation, before reclamation.
        if (args[0] === lock && ++reads === 2) {
            rmSync(lock);
            owner = startOwner();
            // Bound a regressed waiter's five-minute timeout without sleeping.
            clock.mockReturnValue(now + 300_001);
        }
        return stat;
    });
    const operation = vi.fn();
    let failure: unknown;
    try { withCodexConfigLock(operation); } catch (error) { failure = error; }

    expect(owner).toBeDefined();
    expect(failure).toMatchObject({ code: "shared-mutation-lock-stale" });
    expect(operation).not.toHaveBeenCalled();
    expect(readFileSync(lock, "utf8")).toBe(owner!.record);
    expect(realFs.lstatSync(lock).ino).toBe(owner!.inode);
    expect(() => withSharedMutationLock(lock, operation, { waitMs: 0, reclaimStale: false })).toThrow(/Timed out acquiring/);
    expect(operation).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(readdirSync(join(state.home, ".ccc"))).toEqual(["codex-config.lock"]);

    writeFileSync(owner!.release, "release");
    expect(await owner!.exit).toEqual({ code: 0, stderr: "" });
    expect(existsSync(lock)).toBe(false);
});
