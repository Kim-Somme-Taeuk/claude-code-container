import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { chownSync, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { request } from "http";
import { connect, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

describe("clipboard state across real daemon restarts", () => {
    let fixtureRoot: string;
    let home: string;
    let portFile: string;
    let startingLock: string;
    let ownLock: string;
    let children: ChildProcess[];
    let sockets: Socket[];
    let descriptors: number[];

    beforeAll(() => {
        fixtureRoot = mkdtempSync(join(tmpdir(), "ccc-clipboard-state-"));
        writeFileSync(join(fixtureRoot, "package.json"), '{"type":"module"}');
        for (const name of ["clipboard-server", "utils"]) {
            const source = readFileSync(fileURLToPath(new URL(`../${name}.ts`, import.meta.url)), "utf8");
            writeFileSync(join(fixtureRoot, `${name}.js`), transpileModule(source, {
                compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
            }).outputText);
        }
        writeFileSync(join(fixtureRoot, "home.cjs"), `
            require("os").homedir = () => process.env.CCC_CLIPBOARD_TEST_HOME;
            require("module").syncBuiltinESMExports();
        `);
        writeFileSync(join(fixtureRoot, "driver.js"), `
            import { ensureClipboardServer, stopClipboardServerIfLast } from "./clipboard-server.js";
            if (process.argv[2] === "ensure") console.log(await ensureClipboardServer());
            else stopClipboardServerIfLast(process.argv[3] || null);
        `);
    });

    beforeEach(() => {
        home = mkdtempSync(join(fixtureRoot, "home-"));
        portFile = join(home, ".ccc", "clipboard.port");
        startingLock = join(home, ".ccc", "clipboard.starting");
        ownLock = join(home, ".ccc", "locks", "test.lock");
        mkdirSync(join(home, ".ccc", "locks"), { recursive: true });
        writeFileSync(ownLock, String(process.pid));
        children = [];
        sockets = [];
        descriptors = [];
    });

    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        try {
            const record = readRecord();
            await send(record, "/shutdown", "POST");
            await waitFor(async () => {
                try { await send(record, "/health"); return false; } catch { return true; }
            });
        } catch { /* no published daemon */ }
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        for (const fd of descriptors) closeSync(fd);
        await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve() : new Promise<void>((resolve) => child.once("close", () => resolve()))));
        rmSync(home, { recursive: true, force: true });
    });

    afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

    function start(script: string, ...args: string[]) {
        const child = spawn(process.execPath, [join(fixtureRoot, script), ...args], {
            env: {
                ...process.env,
                CCC_CLIPBOARD_TEST_HOME: home,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${JSON.stringify(join(fixtureRoot, "home.cjs"))}`,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stdout, stderr }));
        });
        return { child, exited };
    }

    function readRecord() {
        const bytes = readFileSync(portFile, "utf8");
        const [port, token] = bytes.split(":");
        return { bytes, port: Number(port), token };
    }

    async function waitFor(check: () => boolean | Promise<boolean>) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            try { if (await check()) return; } catch { /* publication may be in progress */ }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Timed out waiting for clipboard fixture");
    }

    function send(record: { port: number; token: string }, path: string, method = "GET"): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = request({ hostname: "127.0.0.1", port: record.port, path, method,
                headers: { Authorization: `Bearer ${record.token}`, Connection: "close" }, timeout: 1000 }, (res) => {
                let body = "";
                res.on("data", (data) => { body += data; });
                res.on("end", () => resolve(body));
            });
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Clipboard fixture request timed out")));
            req.end();
        });
    }

    async function published(previousBytes?: string) {
        await waitFor(async () => {
            const record = readRecord();
            return record.bytes !== previousBytes && /^\d+:[a-f0-9]{32}$/.test(record.bytes)
                && JSON.parse(await send(record, "/health")).valid === true;
        });
        return readRecord();
    }

    it.each(["missing", "empty", "permissive"])("publishes private metadata for a %s port file", async (state) => {
        if (state !== "missing") writeFileSync(portFile, "", { mode: state === "permissive" ? 0o644 : 0o600 });
        const before = state !== "missing" ? statSync(portFile) : null;
        start("clipboard-server.js", "--serve");
        await published();
        const after = statSync(portFile);
        if (before) expect(after.ino).toBe(before.ino);
        if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600);
    });

    it("retains bytes and the bound inode after last-session stop, then republishes on that inode", async () => {
        const daemon = start("clipboard-server.js", "--serve");
        const old = await published();
        const fd = openSync(portFile, "r");
        descriptors.push(fd);
        const inode = fstatSync(fd).ino;

        expect((await start("driver.js", "stop", ownLock).exited).code).toBe(0);
        expect((await daemon.exited).code).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(old.bytes);
        expect(statSync(portFile).ino).toBe(inode);

        const restarted = await start("driver.js", "ensure").exited;
        expect(restarted.code, restarted.stderr).toBe(0);
        const fresh = await published(old.bytes);
        expect(Number(restarted.stdout.trim())).toBe(fresh.port);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(fd, "utf8")).toBe(fresh.bytes);
    });

    it("reuses a healthy daemon and preserves it while another session is active", async () => {
        start("clipboard-server.js", "--serve");
        const record = await published();
        const inode = statSync(portFile).ino;
        const reused = await start("driver.js", "ensure").exited;
        expect(reused.code, reused.stderr).toBe(0);
        expect(Number(reused.stdout.trim())).toBe(record.port);
        writeFileSync(join(home, ".ccc", "locks", "other.lock"), String(process.pid));
        expect((await start("driver.js", "stop", ownLock).exited).code).toBe(0);
        expect(JSON.parse(await send(record, "/health")).valid).toBe(true);
        expect(readFileSync(portFile, "utf8")).toBe(record.bytes);
        expect(statSync(portFile).ino).toBe(inode);
    });

    it("keeps successor publication and startup lock when an old daemon finishes shutdown late", async () => {
        const oldDaemon = start("clipboard-server.js", "--serve");
        const old = await published();
        const inode = statSync(portFile).ino;
        const pending = connect(old.port, "127.0.0.1");
        sockets.push(pending);
        await new Promise<void>((resolve) => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        await send(old, "/shutdown", "POST");
        expect(oldDaemon.child.exitCode).toBeNull();
        start("clipboard-server.js", "--serve");
        const successor = await published(old.bytes);
        writeFileSync(startingLock, "successor-startup-lock");
        pending.destroy();
        expect((await oldDaemon.exited).code).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(successor.bytes);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(startingLock, "utf8")).toBe("successor-startup-lock");
        expect(JSON.parse(await send(successor, "/health")).valid).toBe(true);
    });

    it("stale callers wait for the existing startup lock and share authenticated successor state", async () => {
        writeFileSync(portFile, "1:stale-token", { mode: 0o600 });
        const inode = statSync(portFile).ino;
        writeFileSync(startingLock, "startup-in-progress");
        const first = start("driver.js", "ensure");
        const second = start("driver.js", "ensure");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(readFileSync(startingLock, "utf8")).toBe("startup-in-progress");
        expect(readFileSync(portFile, "utf8")).toBe("1:stale-token");
        start("clipboard-server.js", "--serve");
        const record = await published();
        for (const result of await Promise.all([first.exited, second.exited])) {
            expect(result.code, result.stderr).toBe(0);
            expect(Number(result.stdout.trim())).toBe(record.port);
        }
        expect(statSync(portFile).ino).toBe(inode);
    });

    it.each(["symlink", "hardlink", "directory"])("refuses a %s target without modifying its sentinel", async (kind) => {
        const sentinel = join(home, "sentinel");
        writeFileSync(sentinel, "private-sentinel-bytes", { mode: 0o640 });
        if (kind === "symlink") symlinkSync(sentinel, portFile);
        else if (kind === "hardlink") linkSync(sentinel, portFile);
        else {
            mkdirSync(portFile);
            writeFileSync(join(portFile, "sentinel"), "directory-sentinel");
        }
        const before = statSync(sentinel);
        const targetBefore = lstatSync(portFile);
        const result = await start("clipboard-server.js", "--serve").exited;
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Failed to start clipboard server");
        expect(readFileSync(sentinel, "utf8")).toBe("private-sentinel-bytes");
        expect(statSync(sentinel)).toMatchObject({ ino: before.ino, mode: before.mode, uid: before.uid, size: before.size });
        expect(lstatSync(portFile)).toMatchObject({ ino: targetBefore.ino, mode: targetBefore.mode });
        if (kind === "directory") expect(readFileSync(join(portFile, "sentinel"), "utf8")).toBe("directory-sentinel");
    });

    it("refuses a dangling symlink without creating its target", async () => {
        const target = join(home, "must-stay-missing");
        symlinkSync(target, portFile);
        const before = lstatSync(portFile);
        const result = await start("clipboard-server.js", "--serve").exited;
        expect(result.code).toBe(1);
        expect(() => statSync(target)).toThrow();
        expect(lstatSync(portFile)).toMatchObject({ ino: before.ino, mode: before.mode });
    });

    it.skipIf(process.getuid?.() !== 0)("refuses a foreign-owned file before changing its bytes or mode", async () => {
        writeFileSync(portFile, "foreign-owner-sentinel", { mode: 0o666 });
        chownSync(portFile, 65534, 65534);
        const before = statSync(portFile);
        const result = await start("clipboard-server.js", "--serve").exited;
        expect(result.code).toBe(1);
        expect(readFileSync(portFile, "utf8")).toBe("foreign-owner-sentinel");
        expect(statSync(portFile)).toMatchObject({ ino: before.ino, mode: before.mode, uid: before.uid, size: before.size });
    });
});
