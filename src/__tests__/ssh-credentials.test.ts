import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SSH_COPY_INSTALL_SCRIPT } from "../ssh-credentials.js";

const supported = process.platform === "linux";
let root: string;
let source: string;
let target: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-ssh-test-"));
    source = join(root, "source");
    target = join(root, "copy");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(join(source, "id_ed25519"), "fake-key-first", { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function archive(): Buffer {
    const result = spawnSync("tar", ["-cf", "-", "-C", source, "."]);
    expect(result.status, result.stderr.toString()).toBe(0);
    return result.stdout;
}
function install(input = archive(), env = process.env) {
    return spawnSync("bash", ["-c", SSH_COPY_INSTALL_SCRIPT, "test", target], { input, env, encoding: "utf8" });
}
function expectSuccess(result: ReturnType<typeof install>) {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
}

describe.skipIf(!supported)("SSH credential archive installation", () => {
    it("prepares usable private files and traversable nested directories without changing source", () => {
        mkdirSync(join(source, "nested"), { mode: 0o755 });
        writeFileSync(join(source, "nested", "key"), "nested-key", { mode: 0o644 });
        const before = statSync(join(source, "id_ed25519"));
        expectSuccess(install());
        expect(readFileSync(join(target, "id_ed25519"), "utf8")).toBe("fake-key-first");
        expect(readFileSync(join(target, "nested", "key"), "utf8")).toBe("nested-key");
        for (const path of [target, join(target, "nested")]) expect(statSync(path).mode & 0o777).toBe(0o700);
        for (const path of [join(target, "id_ed25519"), join(target, "nested", "key")]) {
            expect(statSync(path).mode & 0o777).toBe(0o600);
            expect(statSync(path).uid).toBe(process.getuid!());
        }
        expect(statSync(join(source, "id_ed25519")).mode).toBe(before.mode);
        expect(statSync(join(source, "id_ed25519")).uid).toBe(before.uid);
        expect(readFileSync(join(source, "id_ed25519"), "utf8")).toBe("fake-key-first");
    });

    it("refreshes without nesting, removes deleted keys and preserves learned host entries", () => {
        writeFileSync(join(source, "id_rsa"), "removed-key");
        writeFileSync(join(source, "known_hosts"), "host-entry\n");
        expectSuccess(install());
        writeFileSync(join(target, "known_hosts"), "host-entry\nlearned-entry\n");
        writeFileSync(join(source, "id_ed25519"), "fake-key-second");
        rmSync(join(source, "id_rsa"));
        expectSuccess(install());
        expect(readFileSync(join(target, "id_ed25519"), "utf8")).toBe("fake-key-second");
        expect(existsSync(join(target, "id_rsa"))).toBe(false);
        expect(existsSync(join(target, ".ssh"))).toBe(false);
        expect(readFileSync(join(target, "known_hosts"), "utf8")).toBe("host-entry\nlearned-entry\n");
        rmSync(join(source, "known_hosts"));
        expectSuccess(install());
        expect(readFileSync(join(target, "known_hosts"), "utf8")).toContain("learned-entry");
    });

    it("supports an empty source and removes the old managed identities", () => {
        expectSuccess(install());
        rmSync(join(source, "id_ed25519"));
        expectSuccess(install());
        expect(existsSync(join(target, "id_ed25519"))).toBe(false);
    });

    it("rejects a destination symlink without modifying its target", () => {
        const sentinel = join(root, "sentinel");
        mkdirSync(sentinel, { mode: 0o755 });
        writeFileSync(join(sentinel, "id_ed25519"), "untouched");
        symlinkSync(sentinel, target);
        expect(install().status).not.toBe(0);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(sentinel, "id_ed25519"), "utf8")).toBe("untouched");
        expect(statSync(sentinel).mode & 0o777).toBe(0o755);
    });

    it.each(["file-link", "directory-link", "fifo"])("rejects source %s and retains previous copy", (kind) => {
        expectSuccess(install());
        const sentinel = join(root, "sentinel");
        mkdirSync(sentinel, { mode: 0o755 });
        writeFileSync(join(sentinel, "key"), "untouched", { mode: 0o644 });
        const special = join(source, "special");
        if (kind === "fifo") expect(spawnSync("mkfifo", [special]).status).toBe(0);
        else symlinkSync(kind === "file-link" ? join(sentinel, "key") : sentinel, special);
        writeFileSync(join(source, "id_ed25519"), "not-published");
        expect(install().status).not.toBe(0);
        expect(readFileSync(join(target, "id_ed25519"), "utf8")).toBe("fake-key-first");
        expect(readFileSync(join(sentinel, "key"), "utf8")).toBe("untouched");
        expect(statSync(join(sentinel, "key")).mode & 0o777).toBe(0o644);
    });

    it("does not follow an old known_hosts symlink", () => {
        expectSuccess(install());
        const sentinel = join(root, "sentinel");
        writeFileSync(sentinel, "private sentinel");
        symlinkSync(sentinel, join(target, "known_hosts"));
        expectSuccess(install());
        expect(existsSync(join(target, "known_hosts"))).toBe(false);
        expect(readFileSync(sentinel, "utf8")).toBe("private sentinel");
    });

    it("retains previous credentials on invalid archive", () => {
        expectSuccess(install());
        expect(install(Buffer.from("invalid archive")).status).not.toBe(0);
        expect(readFileSync(join(target, "id_ed25519"), "utf8")).toBe("fake-key-first");
    });

    it("rolls back if publication fails after moving the previous snapshot", () => {
        expectSuccess(install());
        const bin = join(root, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "mv"), '#!/bin/bash\nfor arg in "$@"; do case "$arg" in */next) exit 1;; esac; done\nexec /bin/mv "$@"\n');
        chmodSync(join(bin, "mv"), 0o700);
        writeFileSync(join(source, "id_ed25519"), "not-published");
        expect(install(archive(), { ...process.env, PATH: `${bin}:${process.env.PATH}` }).status).not.toBe(0);
        expect(readFileSync(join(target, "id_ed25519"), "utf8")).toBe("fake-key-first");
    });

    it("serializes simultaneous refreshes into a complete snapshot", async () => {
        const first = archive();
        writeFileSync(join(source, "id_ed25519"), "fake-key-second");
        const second = archive();
        const run = (input: Buffer) => new Promise<number | null>((resolve, reject) => {
            const child = spawn("bash", ["-c", SSH_COPY_INSTALL_SCRIPT, "test", target], { stdio: ["pipe", "ignore", "pipe"] });
            child.on("error", reject);
            child.on("close", resolve);
            child.stdin.end(input);
        });
        expect(await Promise.all([run(first), run(second)])).toEqual([0, 0]);
        expect(["fake-key-first", "fake-key-second"]).toContain(readFileSync(join(target, "id_ed25519"), "utf8"));
    });
});
