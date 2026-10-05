import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { gitSigningKeyRewriteShell, sshCredentialCopyShell } from "../docker.js";

const temporaryRoots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ccc-git-signing-key-"));
    temporaryRoots.push(root);
    return root;
}

function configureSigningKeys(configPath: string, values: string[]): void {
    for (const value of values) {
        const result = spawnSync(
            "git",
            ["config", "--file", configPath, "--add", "user.signingkey", value],
            { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
    }
}

function readSigningKeys(configPath: string): string[] {
    const result = spawnSync(
        "git",
        ["config", "--file", configPath, "--get-all", "user.signingkey"],
        { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trimEnd().split("\n");
}

function runRewrite(options: {
    signingKeys: string[];
    hostSshRoot: string;
    copiedKeyName?: string;
    copiedKeySymlink?: boolean;
}): { configPath: string; copiedRoot: string } {
    const root = makeRoot();
    const configPath = join(root, "gitconfig");
    const copiedRoot = join(root, "ssh-copy");
    mkdirSync(copiedRoot);
    configureSigningKeys(configPath, options.signingKeys);

    if (options.copiedKeyName) {
        const copiedKey = join(copiedRoot, options.copiedKeyName);
        if (options.copiedKeySymlink) {
            const outsideKey = join(root, "outside-key");
            writeFileSync(outsideKey, "private-key");
            symlinkSync(outsideKey, copiedKey);
        } else {
            writeFileSync(copiedKey, "private-key");
        }
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");
    }

    const result = spawnSync(
        "sh",
        [
            "-c",
            gitSigningKeyRewriteShell(),
            "ccc-signing-key-rewrite",
            configPath,
            options.hostSshRoot,
            copiedRoot,
        ],
        { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return { configPath, copiedRoot };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("host Git signing-key rewrite", () => {
    it.each([
        {
            name: "macOS",
            signingKey: "/Users/ecokjkim/.ssh/id_ed25519",
            hostSshRoot: "/Users/ecokjkim/.ssh",
        },
        {
            name: "Windows",
            signingKey: "C:\\Users\\Luxus\\.ssh\\id_ed25519",
            hostSshRoot: "C:/Users/Luxus/.ssh",
        },
    ])("rewrites an exact $name host key after it was copied", ({ signingKey, hostSshRoot }) => {
        const { configPath, copiedRoot } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot,
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual([join(copiedRoot, "id_ed25519")]);
    });

    it.each([
        ["a key outside the host home", "/opt/team/.ssh/id_ed25519"],
        ["a relative key", "keys/id_ed25519"],
        ["an inline key", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest"],
        ["an unrecognized key name", "/Users/ecokjkim/.ssh/team-signing-key"],
    ])("preserves %s", (_name, signingKey) => {
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when the copied key is missing", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when a stale copied key has no completion marker", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const root = makeRoot();
        const configPath = join(root, "gitconfig");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        configureSigningKeys(configPath, [signingKey]);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");

        const result = spawnSync(
            "sh",
            ["-c", gitSigningKeyRewriteShell(), "rewrite", configPath, "/Users/ecokjkim/.ssh", copiedRoot],
            { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves the host path when the copied key is a symlink", () => {
        const signingKey = "/Users/ecokjkim/.ssh/id_ed25519";
        const { configPath } = runRewrite({
            signingKeys: [signingKey],
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
            copiedKeySymlink: true,
        });

        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });

    it("preserves multiple signing-key values", () => {
        const signingKeys = [
            "/Users/ecokjkim/.ssh/id_ed25519",
            "/Users/ecokjkim/.ssh/id_rsa",
        ];
        const { configPath } = runRewrite({
            signingKeys,
            hostSshRoot: "/Users/ecokjkim/.ssh",
            copiedKeyName: "id_ed25519",
        });

        expect(readSigningKeys(configPath)).toEqual(signingKeys);
    });

    it("does not evaluate shell syntax in a configured value", () => {
        const root = makeRoot();
        const sentinel = join(root, "executed");
        const signingKey = `/Users/ecokjkim/.ssh/id_ed25519$(touch ${sentinel})`;
        const configPath = join(root, "gitconfig");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        configureSigningKeys(configPath, [signingKey]);
        writeFileSync(join(copiedRoot, "id_ed25519"), "private-key");

        const result = spawnSync(
            "sh",
            ["-c", gitSigningKeyRewriteShell(), "rewrite", configPath, "/Users/ecokjkim/.ssh", copiedRoot],
            { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(sentinel)).toThrow();
        expect(readSigningKeys(configPath)).toEqual([signingKey]);
    });
});

describe("container SSH credential copy", () => {
    function runCopy(
        sourceRoot: string,
        copiedRoot: string,
        env: NodeJS.ProcessEnv = process.env,
        privilegedRead = false,
    ): ReturnType<typeof spawnSync> {
        return spawnSync(
            "sh",
            ["-c", sshCredentialCopyShell(privilegedRead), "ccc-ssh-copy", sourceRoot, copiedRoot],
            { encoding: "utf8", env },
        );
    }

    const canElevate = process.platform !== "win32" && process.getuid?.() !== 0
        && spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;

    it.skipIf(!canElevate)("copies a private host key across a UID boundary without changing host permissions", () => {
        const root = makeRoot();
        const source = join(root, "host-ssh");
        const copied = join(root, "ssh-copy");
        mkdirSync(source, { mode: 0o700 });
        writeFileSync(join(source, "id_ed25519"), "fixture-key-not-a-real-secret", { mode: 0o600 });
        expect(spawnSync("sudo", ["-n", "chown", "-R", "0:0", source]).status).toBe(0);
        try {
            expect(runCopy(source, copied).status).toBe(1);
            const result = runCopy(source, copied, process.env, true);
            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(join(copied, "id_ed25519"), "utf8")).toBe("fixture-key-not-a-real-secret");
            expect(statSync(copied).uid).toBe(process.getuid!());
            expect(statSync(join(copied, "id_ed25519")).uid).toBe(process.getuid!());
            expect(statSync(join(copied, "id_ed25519")).mode & 0o777).toBe(0o600);
            expect(statSync(source).uid).toBe(0);
            expect(statSync(source).mode & 0o777).toBe(0o700);
            expect(readdirSync(root).some(name => name.startsWith(".ccc-ssh-archive."))).toBe(false);
        } finally {
            expect(spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, source]).status).toBe(0);
        }
    });

    it("cleans archive and stale credentials when the privileged reader fails", () => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        for (const path of [source, copied, bin]) mkdirSync(path);
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
        expect(runCopy(source, copied, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, true).status).toBe(1);
        expect(readdirSync(root)).toEqual(expect.not.arrayContaining(["ssh-copy"]));
        expect(readdirSync(root).some(name => name.startsWith(".ccc-ssh-archive.") || name.includes(".next."))).toBe(false);
    });

    it("replaces a copied completion-marker symlink without touching its target", () => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const outside = join(root, "outside");
        mkdirSync(source);
        writeFileSync(outside, "untouched");
        symlinkSync(outside, join(source, ".ccc-copy-complete"));
        expect(runCopy(source, copied).status).toBe(0);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
        expect(readFileSync(join(copied, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
    });

    it.each(["chmod", "publish", "extract"])("invalidates stale credentials and staging on %s failure", failure => {
        const root = makeRoot();
        const source = join(root, "source");
        const copied = join(root, "ssh-copy");
        const bin = join(root, "bin");
        for (const path of [source, copied, bin]) mkdirSync(path);
        writeFileSync(join(source, "id_ed25519"), "new-fixture");
        writeFileSync(join(copied, "id_ed25519"), "stale-fixture");
        writeFileSync(join(copied, ".ccc-copy-complete"), "complete\n");
        const command = failure === "publish" ? "mv" : failure === "extract" ? "tar" : "chmod";
        const body = failure === "publish" ? 'case "$1" in *.next.*) exit 42;; esac\nexec /bin/mv "$@"'
            : failure === "extract" ? 'case "$1" in --no-same-owner) exit 42;; esac\nexec /bin/tar "$@"' : "exit 42";
        writeFileSync(join(bin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        // This fixture tests extraction failure without requiring privilege.
        writeFileSync(join(bin, "sudo"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
        expect(runCopy(source, copied, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, failure === "extract").status).toBe(1);
        expect(readdirSync(root)).not.toContain("ssh-copy");
        expect(readdirSync(root).filter(name => name.startsWith("."))).toEqual([]);
    });

    it("replaces an existing copy instead of nesting the source directory", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "old-key");

        const first = runCopy(sourceRoot, copiedRoot);
        expect(first.status, first.stderr).toBe(0);
        expect(readFileSync(join(copiedRoot, "id_ed25519"), "utf8")).toBe("old-key");

        writeFileSync(join(sourceRoot, "id_ed25519"), "new-key");
        const second = runCopy(sourceRoot, copiedRoot);
        expect(second.status, second.stderr).toBe(0);
        expect(readFileSync(join(copiedRoot, "id_ed25519"), "utf8")).toBe("new-key");
        expect(() => readFileSync(join(copiedRoot, ".ssh", "id_ed25519"))).toThrow();
        expect(readFileSync(join(copiedRoot, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
    });

    it("applies restrictive permissions to a completed copy", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "private-key");
        writeFileSync(join(sourceRoot, "id_ed25519.pub"), "public-key");
        writeFileSync(join(sourceRoot, "known_hosts"), "host-key");

        const result = runCopy(sourceRoot, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(statSync(copiedRoot).mode & 0o777).toBe(0o700);
        expect(statSync(join(copiedRoot, "id_ed25519")).mode & 0o777).toBe(0o600);
        expect(statSync(join(copiedRoot, "id_ed25519.pub")).mode & 0o777).toBe(0o644);
        expect(statSync(join(copiedRoot, "known_hosts")).mode & 0o777).toBe(0o644);
        expect(statSync(join(copiedRoot, ".ccc-copy-complete")).mode & 0o777).toBe(0o600);
    });

    it("does not follow public-key or known-hosts symlinks while setting permissions", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        const outsidePublicKey = join(root, "outside.pub");
        const outsideKnownHosts = join(root, "outside-known-hosts");
        mkdirSync(sourceRoot);
        writeFileSync(outsidePublicKey, "outside-public-key");
        writeFileSync(outsideKnownHosts, "outside-host-key");
        chmodSync(outsidePublicKey, 0o600);
        chmodSync(outsideKnownHosts, 0o600);
        symlinkSync(outsidePublicKey, join(sourceRoot, "id_ed25519.pub"));
        symlinkSync(outsideKnownHosts, join(sourceRoot, "known_hosts"));

        const result = runCopy(sourceRoot, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(statSync(outsidePublicKey).mode & 0o777).toBe(0o600);
        expect(statSync(outsideKnownHosts).mode & 0o777).toBe(0o600);
    });

    it("removes a stale copy when the source directory is unavailable", () => {
        const root = makeRoot();
        const missingSource = join(root, "missing-ssh");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(copiedRoot);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");

        const result = runCopy(missingSource, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
    });

    it("removes a stale copy when the source root is a symlink", () => {
        const root = makeRoot();
        const realSource = join(root, "real-source");
        const sourceLink = join(root, "source-link");
        const copiedRoot = join(root, "ssh-copy");
        mkdirSync(realSource);
        writeFileSync(join(realSource, "id_ed25519"), "unexpected-key");
        symlinkSync(realSource, sourceLink);
        mkdirSync(copiedRoot);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");

        const result = runCopy(sourceLink, copiedRoot);

        expect(result.status, result.stderr).toBe(0);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
    });

    it("removes a stale completed copy when refresh copying fails", () => {
        const root = makeRoot();
        const sourceRoot = join(root, "source-ssh");
        const copiedRoot = join(root, "ssh-copy");
        const fakeBin = join(root, "fake-bin");
        mkdirSync(sourceRoot);
        writeFileSync(join(sourceRoot, "id_ed25519"), "new-key");
        mkdirSync(copiedRoot);
        mkdirSync(fakeBin);
        writeFileSync(join(copiedRoot, "id_ed25519"), "stale-key");
        writeFileSync(join(copiedRoot, ".ccc-copy-complete"), "complete\n");
        const failingCopy = join(fakeBin, "cp");
        writeFileSync(failingCopy, "#!/bin/sh\nexit 42\n");
        chmodSync(failingCopy, 0o755);

        const result = runCopy(sourceRoot, copiedRoot, {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        });

        expect(result.status).toBe(1);
        expect(() => readFileSync(join(copiedRoot, "id_ed25519"))).toThrow();
        expect(() => readFileSync(join(copiedRoot, ".ccc-copy-complete"))).toThrow();
        expect(readdirSync(root).some((name) => name.includes(".ssh-copy.next."))).toBe(false);
    });
});
