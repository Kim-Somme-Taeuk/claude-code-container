import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
    events: [] as string[],
    running: false,
    missing: new Set<string>(),
    failedPackages: new Set<string>(),
    failWrapper: false,
    failProbe: false,
    exitStatus: 0,
    warnAfterCommand: false,
    spawn: vi.fn(),
    unlink: vi.fn(),
    restore: vi.fn(),
    prepare: vi.fn(),
    harness: vi.fn(),
    buildMcp: vi.fn(),
    cleanup: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
    spawnSync: fixture.spawn,
}));

vi.mock("fs", async (importOriginal) => ({
    ...await importOriginal<typeof import("fs")>(),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: fixture.unlink,
}));

vi.mock("../utils.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../utils.js")>(),
    collectForwardedEnv: vi.fn(() => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 })),
    writeEnvFile: vi.fn(() => "/tmp/ccc-login-startup.env"),
    prompt: vi.fn(async () => "n"),
}));

vi.mock("../docker.js", () => ({
    ensureDockerRunning: vi.fn(),
    getContainerName: vi.fn(() => "ccc-startup-test"),
    getContainerStatus: vi.fn(() => ({ exists: true, running: fixture.running, imageId: "image" })),
    getCurrentImageId: vi.fn(() => "image"),
    startProjectContainer: vi.fn(() => "ccc-startup-test"),
    isContainerRunning: vi.fn(() => true),
    resolveCredentialHostPath: vi.fn((mount: { hostDir: string }) => `/fixture/${mount.hostDir}`),
    restoreCodexConfigHostOwnership: fixture.restore,
    prepareCodexConfigForContainer: fixture.prepare,
    syncClipboardShims: vi.fn(),
}));

vi.mock("../container-runtime.js", () => ({ runtimeCli: vi.fn(() => "docker") }));
vi.mock("../worktree.js", () => ({ getWorktreeGitMounts: vi.fn(() => []) }));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardServer: vi.fn(async () => null) }));
vi.mock("../codex-clipboard-image.js", () => ({
    maybeAttachCodexClipboardImage: vi.fn(async (_project: string, args: string[]) => ({ args })),
}));
vi.mock("../device-lab-broker.js", () => ({
    DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1",
    ensureHostDeviceBroker: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../device-lab-admin.js", () => ({ devicesCliAsync: vi.fn() }));
vi.mock("../lab-runner-admin.js", () => ({ labsCli: vi.fn() }));
vi.mock("../remote.js", () => ({}));
vi.mock("../session.js", () => ({
    createSessionLock: vi.fn(() => "/fixture/session.lock"),
    setSession: vi.fn(),
    setupSignalHandlers: vi.fn(),
    getActiveSessionsForProject: vi.fn(() => []),
    cleanupSession: fixture.cleanup,
}));
vi.mock("../mcp-forward.js", () => ({ buildMcpConfig: fixture.buildMcp }));
vi.mock("../codex-harness.js", () => ({ ensureCodexHarness: fixture.harness }));
vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: (operation: () => unknown) => operation() }));
vi.mock("../localhost-proxy-setup.js", () => ({ setupLocalhostProxy: vi.fn() }));

import { main } from "../index.js";
import { prompt, writeEnvFile } from "../utils.js";
import { createSessionLock } from "../session.js";
import { startProjectContainer } from "../docker.js";
import { tmpdir } from "os";
import { join } from "path";
import { withSharedMutationLock } from "../device-lab-shared-state.js";

const realFs = await vi.importActual<typeof import("fs")>("fs");

const originalArgv = process.argv;

class CliExit extends Error {
    constructor(readonly status: number) {
        super(`CLI exited with ${status}`);
    }
}

function result(status = 0, stdout = "") {
    return { status, stdout, stderr: "", signal: null, pid: 1, output: [] };
}

async function runLogin(): Promise<number> {
    try {
        await main();
    } catch (error) {
        if (error instanceof CliExit) return error.status;
        throw error;
    }
    throw new Error("Login did not exit");
}

function loginCalls(): string[][] {
    return fixture.spawn.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => args.includes("codex") && args.includes("login"));
}

describe("ccc codex login startup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("CCC_PROFILE", "");
        vi.stubEnv("DEBUG", "");
        process.argv = [process.execPath, "ccc", "codex", "login"];
        vi.spyOn(process, "exit").mockImplementation((status) => {
            throw new CliExit(Number(status ?? 0));
        });
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        fixture.events.length = 0;
        fixture.running = false;
        fixture.missing = new Set(["codex"]);
        fixture.failedPackages = new Set();
        fixture.failWrapper = false;
        fixture.failProbe = false;
        fixture.exitStatus = 0;
        fixture.warnAfterCommand = false;
        fixture.restore.mockImplementation(() => {
            fixture.events.push("host-access");
            if (fixture.warnAfterCommand && fixture.events.includes("login")) {
                console.warn("Unable to restore host access to Codex config.toml");
            }
        });
        fixture.prepare.mockImplementation(() => fixture.events.push("container-access"));
        fixture.harness.mockImplementation(() => fixture.events.push("harness"));
        fixture.buildMcp.mockImplementation((_profile, restoreAccess?: () => void) => {
            restoreAccess?.();
            fixture.events.push("mcp");
            return [];
        });
        fixture.unlink.mockImplementation(() => fixture.events.push("unlink-env"));
        fixture.cleanup.mockImplementation(() => fixture.events.push("cleanup"));

        // The real installer runs against a simulated container filesystem.
        // Only runtime calls are replaced; command dispatch and setup stay real.
        fixture.spawn.mockImplementation((_runtime: string, args: string[]) => {
            const script = args.at(-1) ?? "";
            if (args.includes("codex") && args.includes("login")) {
                fixture.events.push("login");
                return result(fixture.missing.has("codex") ? 127 : fixture.exitStatus);
            }
            if (script.includes("echo codex")) {
                const probed = ["gemini", "codex", "opencode"].filter((name) => script.includes(`echo ${name}`));
                fixture.events.push(`probe:${probed.join(",")}`);
                if (fixture.failProbe) return result(1);
                return result(0, probed.filter((name) => fixture.missing.has(name)).join("\n"));
            }
            if (script.includes("npm install -g ")) {
                const packages = script.match(/npm install -g ([^;&\n]+)/)?.[1].trim().split(/\s+/) ?? [];
                fixture.events.push(`install:${packages.join(",")}`);
                return result(packages.some((pkg) => fixture.failedPackages.has(pkg)) ? 1 : 0);
            }
            if (script.includes("mise where node@22")) return result(0, "MISSING\n");
            const wrapper = script.match(/cat > \/home\/ccc\/\.local\/bin\/(\w+)/)?.[1];
            if (wrapper) {
                if (fixture.failWrapper) return result(1);
                fixture.missing.delete(wrapper);
                fixture.events.push(`wrapper:${wrapper}`);
            }
            return result();
        });
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it.each([false, true])("restores host access before MCP generation (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();

        expect(await runLogin()).toBe(0);
        expect(fixture.restore).toHaveBeenCalledTimes(2);
        expect(fixture.events.indexOf("host-access")).toBeLessThan(fixture.events.indexOf("mcp"));
        expect(fixture.events.indexOf("mcp")).toBeLessThan(fixture.events.indexOf("container-access"));
        expect(fixture.events.indexOf("mcp")).toBeLessThan(fixture.events.indexOf("harness"));
        expect(fixture.events.indexOf("harness")).toBeLessThan(fixture.events.indexOf("container-access"));
        expect(fixture.events.slice(-4)).toEqual(["login", "host-access", "unlink-env", "cleanup"]);
    });

    it.each([false, true])("installs only Codex when every npm tool is missing (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.add("gemini");
        fixture.missing.add("opencode");
        fixture.failedPackages.add("opencode-ai");

        expect(await runLogin()).toBe(0);
        expect(fixture.events.filter((event) => event.startsWith("probe:"))).toEqual(["probe:codex"]);
        expect(fixture.events.filter((event) => event.startsWith("install:"))).toEqual(["install:@openai/codex"]);
        expect(fixture.events).toContain("wrapper:codex");
        expect(fixture.missing.has("gemini")).toBe(true);
        expect(fixture.missing.has("opencode")).toBe(true);
        expect(console.warn).not.toHaveBeenCalled();
        expect(loginCalls()).toHaveLength(1);
        expect(fixture.events.indexOf("wrapper:codex")).toBeLessThan(fixture.events.indexOf("login"));
    });

    it("does not bootstrap Harness for another coding tool", async () => {
        fixture.running = true;
        process.argv = [process.execPath, "ccc", "gemini"];

        expect(await runLogin()).toBe(0);
        expect(fixture.harness).not.toHaveBeenCalled();
    });

    it.each(["install", "wrapper", "probe"])("retains the active %s error after cold setup retries and never launches login", async (failure) => {
        if (failure === "install") fixture.failedPackages.add("@openai/codex");
        fixture.failWrapper = failure === "wrapper";
        fixture.failProbe = failure === "probe";

        expect(await runLogin()).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to install tools in container: Failed to .+codex.+exit code 1/i));
        expect(fixture.events.filter((event) => event.startsWith("probe:"))).toHaveLength(2);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.buildMcp).not.toHaveBeenCalled();
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.unlink).not.toHaveBeenCalled();
    });

    it.each(["install", "wrapper", "probe"])("does not launch login when selected-tool %s fails in a running container", async (failure) => {
        fixture.running = true;
        if (failure === "install") fixture.failedPackages.add("@openai/codex");
        fixture.failWrapper = failure === "wrapper";
        fixture.failProbe = failure === "probe";

        await expect(runLogin()).rejects.toThrow(/codex.*exit code 1/i);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.buildMcp).not.toHaveBeenCalled();
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.unlink).not.toHaveBeenCalled();
    });

    it("reuses the repaired Codex wrapper on the next warm invocation", async () => {
        fixture.running = true;

        expect(await runLogin()).toBe(0);
        fixture.events.length = 0;
        expect(await runLogin()).toBe(0);

        expect(fixture.events).toContain("probe:codex");
        expect(fixture.events.some((event) => event.startsWith("install:"))).toBe(false);
        expect(fixture.events).toContain("login");
    });

    it.each([false, true])("preserves login arguments without unsupported default flags (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();

        expect(await runLogin()).toBe(0);
        const [args] = loginCalls();
        expect(args.slice(args.indexOf("ccc-startup-test") + 1)).toEqual(["codex", "login"]);
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it.each([false, true])("cleans up when MCP refuses a stale lock before login (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();
        const directory = realFs.mkdtempSync(join(tmpdir(), "ccc-startup-stale-lock-"));
        const lock = join(directory, "codex-config.lock");
        const contents = "{interrupted";
        realFs.writeFileSync(lock, contents, { mode: 0o600 });
        const old = new Date(Date.now() - 60_000);
        realFs.utimesSync(lock, old, old);
        const before = realFs.lstatSync(lock);
        const operation = vi.fn();
        let failure: unknown;
        fixture.buildMcp.mockImplementation(() => {
            try {
                return withSharedMutationLock(lock, operation, { waitMs: 0, reclaimStale: false });
            } catch (error) {
                failure = error;
                throw error;
            }
        });

        try {
            await expect(runLogin()).rejects.toMatchObject({ code: "shared-mutation-lock-stale" });
            expect(failure).toBeInstanceOf(Error);
            expect(createSessionLock).toHaveBeenCalledOnce();
            expect(startProjectContainer).toHaveBeenCalledOnce();
            expect(fixture.cleanup).toHaveBeenCalledOnce();
            expect(operation).not.toHaveBeenCalled();
            expect(loginCalls()).toHaveLength(0);
            expect(writeEnvFile).not.toHaveBeenCalled();
            expect(fixture.harness).not.toHaveBeenCalled();
            expect(fixture.unlink).not.toHaveBeenCalled();
            expect(realFs.readFileSync(lock, "utf8")).toBe(contents);
            expect(realFs.lstatSync(lock)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
        } finally {
            realFs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it.each([false, true])("preserves MCP access failure and cleans up (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();
        const failure = Object.assign(new Error("Unable to read Codex config: EACCES"), { code: "EACCES" });
        fixture.buildMcp.mockImplementation(() => { throw failure; });

        await expect(runLogin()).rejects.toBe(failure);
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(loginCalls()).toHaveLength(0);
        expect(writeEnvFile).not.toHaveBeenCalled();
    });

    it.each([0, 1, 2, 42, 125, 126, 127, 130, 143])("returns status %s after one execution without updating or wiping Codex state", async (status) => {
        fixture.running = true;
        fixture.missing.clear();
        fixture.exitStatus = status;

        expect(await runLogin()).toBe(status);
        expect(loginCalls()).toHaveLength(1);
        expect(fixture.spawn).toHaveBeenCalledWith("docker", loginCalls()[0], { stdio: "inherit" });
        expect(fixture.events.some((event) => event.startsWith("install:"))).toBe(false);
        expect(fixture.spawn.mock.calls.some(([, args]) =>
            (args as string[]).some((arg) => /rm\s+-rf|\bfind\b|npm install/.test(arg)),
        )).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
        expect(fixture.unlink).toHaveBeenCalledExactlyOnceWith("/tmp/ccc-login-startup.env");
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.events.slice(-4)).toEqual(["login", "host-access", "unlink-env", "cleanup"]);
    });

    it("preserves command status and cleanup when post-command access repair warns", async () => {
        fixture.running = true;
        fixture.missing.clear();
        fixture.exitStatus = 143;
        fixture.warnAfterCommand = true;

        expect(await runLogin()).toBe(143);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("config.toml"));
        expect(fixture.unlink).toHaveBeenCalledWith("/tmp/ccc-login-startup.env");
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.events.slice(-4)).toEqual(["login", "host-access", "unlink-env", "cleanup"]);
    });

    it.each([false, true])("cleans up and retains preparation failure before login or recovery (running=%s)", async (running) => {
        fixture.running = running;
        fixture.missing.clear();
        const error = new Error("Unable to prepare Codex credentials: directory ACL grant failed (Operation not supported)");
        fixture.prepare.mockImplementation(() => { throw error; });

        await expect(runLogin()).rejects.toBe(error);
        expect(loginCalls()).toHaveLength(0);
        expect(fixture.events.some((event) => event.startsWith("install:"))).toBe(false);
        expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("retrying"));
        expect(fixture.restore).toHaveBeenCalledTimes(2);
        expect(fixture.unlink).toHaveBeenCalledExactlyOnceWith("/tmp/ccc-login-startup.env");
        expect(fixture.cleanup).toHaveBeenCalledOnce();
        expect(fixture.events.slice(-3)).toEqual(["host-access", "unlink-env", "cleanup"]);
    });
});
