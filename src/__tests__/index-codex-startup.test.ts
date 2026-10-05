import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
    events: [] as string[], running: false, profile: undefined as string | undefined,
    locked: false, failPostExitLock: false, failTool: false, failState: false, launchFailure: false,
    spawn: vi.fn(), start: vi.fn(), prepare: vi.fn(), restore: vi.fn(), state: vi.fn(), harness: vi.fn(),
}));
vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>(), spawnSync: f.spawn }));
vi.mock("fs", async original => ({ ...await original<typeof import("fs")>(), existsSync: () => true, mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: () => f.events.push("unlink") }));
vi.mock("../utils.js", async original => ({
    ...await original<typeof import("../utils.js")>(),
    collectForwardedEnv: () => ({ forwarded: [], skippedDueToLimit: [], totalBytes: 0 }),
    writeEnvFile: () => "/fixture/exec.env",
}));
vi.mock("../docker.js", () => ({
    ensureDockerRunning: vi.fn(), ensureCredentialHostDir: vi.fn(),
    getContainerName: () => "ccc-fixture", getContainerStatus: () => ({ exists: true, running: f.running, imageId: "sha256:old", containerId: "old-id" }),
    startProjectContainer: f.start, isContainerRunning: () => true,
    restoreCodexConfigHostOwnership: f.restore, prepareCodexConfigForContainer: f.prepare,
    syncClipboardShims: () => f.events.push("clipboard"), ensureContainerManagerSocketAccess: vi.fn(),
}));
vi.mock("../container-runtime.js", async original => ({ ...await original<typeof import("../container-runtime.js")>(), runtimeCli: () => "docker", deviceBrokerBindHostForContainer: () => "127.0.0.1" }));
vi.mock("../worktree.js", async original => ({ ...await original<typeof import("../worktree.js")>(), detectWorktreeWorkspaceBranch: () => null, getWorktreeGitMounts: () => [] }));
vi.mock("../profile.js", async original => ({ ...await original<typeof import("../profile.js")>(), profileExists: () => true }));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardServer: async () => null, hasAnyActiveSessionsExcept: () => false, retireClipboardServerFromPortFile: vi.fn() }));
vi.mock("../home-layout.js", async original => ({ ...await original<typeof import("../home-layout.js")>(), ensureDefaultProfileDir: vi.fn(), migrateHomeLayout: () => f.events.push("layout") }));
vi.mock("../home-layout-container-guard.js", () => ({ hasLegacyHomeLayoutContainerMounts: () => false }));
vi.mock("@ccc/device-lab/device-lab-shared-state.js", async original => ({ ...await original<typeof import("@ccc/device-lab/device-lab-shared-state.js")>(), withSharedMutationLock: (_key: string, operation: () => unknown) => operation() }));
vi.mock("@ccc/device-lab/device-lab-broker.js", () => ({ DEVICE_BROKER_DEFAULT_HOST: "127.0.0.1", ensureHostDeviceBroker: async () => ({ ok: true }) }));
vi.mock("../session.js", () => ({
    createSessionLock: () => "/fixture/session.lock", setSession: vi.fn(), setSessionContainerId: vi.fn(), setupSignalHandlers: vi.fn(),
    getActiveSessionsForContainer: () => [], cleanupSession: () => f.events.push("cleanup"),
    withContainerLifecycleLock: (_key: string, operation: () => unknown) => operation(),
    withContainerSetupLockAsync: async (_key: string, operation: () => unknown) => operation(),
}));
vi.mock("../container-setup.js", () => ({
    CLAUDE_BIN_PATH: "/home/ccc/.local/bin/claude", ensureUvAvailable: () => f.events.push("uv"),
    ensureTools: (id: string, tool: {name: string}) => { expect(id).toBe("final-id"); f.events.push(`tool:${tool.name}`); if (f.failTool) throw new Error("tool unavailable"); },
}));
vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: (operation: () => unknown, profile?: string) => {
    if (f.failPostExitLock && f.events.includes("command")) throw new Error("post-exit lock unavailable");
    expect(profile).toBe(f.profile); expect(f.locked).toBe(false); f.locked = true;
    try { return operation(); } finally { f.locked = false; }
} }));
vi.mock("../mcp-forward.js", () => ({ buildMcpConfig: (profile?: string, restore?: () => void) => {
    expect(profile).toBe(f.profile); f.locked = true; try { restore?.(); } finally { f.locked = false; }
    f.events.push("mcp"); return [];
} }));
vi.mock("../codex-state-ownership.js", () => ({ assertCodexStateAccessible: f.state }));
vi.mock("../codex-harness.js", () => ({ ensureCodexHarness: f.harness }));
vi.mock("../localhost-proxy-setup.js", () => ({ setupLocalhostProxy: () => f.events.push("proxy") }));
vi.mock("../codex-clipboard-image.js", () => ({ maybeAttachCodexClipboardImage: async (_path: string, args: string[]) => ({ args }) }));
vi.mock("../codex-launch.js", () => ({ prepareCodexLaunch: (_runtime: string, args: string[], command: string[]) => {
    expect(args).toContain("final-id"); f.events.push("launch-preparation");
    return f.launchFailure ? { ok: false, status: 9, error: "daemon unavailable" } : { ok: true, command };
} }));
import { main } from "../index.js";
class Exit extends Error { constructor(readonly status: number) { super(`exit ${status}`); } }
const originalArgv = process.argv;
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("CCC_PROFILE", ""); vi.stubEnv("DEBUG", ""); vi.stubEnv("container", "");
    process.argv = [process.execPath, "ccc", "codex", "resume", "--last"];
    f.events = []; f.running = false; f.profile = undefined; f.locked = false; f.failPostExitLock = false; f.failTool = false; f.failState = false; f.launchFailure = false;
    vi.spyOn(process, "exit").mockImplementation(code => { throw new Exit(Number(code)); });
    vi.spyOn(process.stderr, "write").mockReturnValue(true); vi.spyOn(console, "error").mockImplementation(() => {});
    f.start.mockImplementation((...args: unknown[]) => { f.events.push("start"); (args[7] as (id: string) => void)("final-id"); return "ccc-fixture"; });
    f.restore.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("restore"); });
    f.prepare.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); expect(f.locked).toBe(true); f.events.push("prepare"); });
    f.state.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("state"); if (f.failState) throw new Error("state inaccessible"); });
    f.harness.mockImplementation((id, profile) => { expect(id).toBe("final-id"); expect(profile).toBe(f.profile); f.events.push("harness"); });
    f.spawn.mockImplementation((_runtime, args: string[]) => { if (args.includes("codex")) f.events.push("command"); return { status: 0, stdout: "", stderr: "" }; });
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])("preserves final-ID Codex setup and resume ordering when initially running=%s", async running => {
    f.running = running; f.profile = "work"; vi.stubEnv("CCC_PROFILE", "work");
    await expect(main()).rejects.toMatchObject({ status: 0 });
    const ordered = ["start", "mcp", "tool:codex", "prepare", "state", "harness", "clipboard", "launch-preparation", "command"];
    for (let i=1;i<ordered.length;i++) expect(f.events.indexOf(ordered[i])).toBeGreaterThan(f.events.indexOf(ordered[i-1]));
    expect(f.events.includes("uv")).toBe(!running);
    expect(f.events.slice(-4)).toEqual(["command", "restore", "unlink", "cleanup"]);
    expect(f.spawn.mock.calls.some(([, args]) => args[0] === "rm" || args[0] === "rmi")).toBe(false);
    expect(f.start).toHaveBeenCalledOnce();
    const command = f.spawn.mock.calls.find(([, args]) => args.includes("codex"))![1];
    expect(command).toContain("resume"); expect(command).toContain("--last");
});
it.each(["tool", "state"])("stops before launch after %s setup failure without retrying a live container", async failure => {
    f.running = true; f.failTool = failure === "tool"; f.failState = failure === "state";
    await expect(main()).rejects.toThrow(failure === "tool" ? "tool unavailable" : "state inaccessible");
    expect(f.events).not.toContain("command"); expect(f.events).not.toContain("harness"); expect(f.start).toHaveBeenCalledOnce();
});
it("preserves upstream daemon-preparation failure status and cleans invocation state without launching", async () => {
    f.launchFailure = true;
    await expect(main()).rejects.toMatchObject({ status: 9 });
    expect(f.events).not.toContain("command");
    expect(f.events.slice(-3)).toEqual(["restore", "unlink", "cleanup"]);
});

it("cleans the environment file and session after post-command config lock failure", async () => {
    f.failPostExitLock = true;
    await expect(main()).rejects.toBeInstanceOf(Error);
    expect(f.events).toContain("command");
    expect(f.events).toContain("unlink");
    expect(f.events).toContain("cleanup");
});

it("normalizes CCC_PROFILE=default before selecting config/state/Harness", async () => {
    vi.stubEnv("CCC_PROFILE", "default");
    await expect(main()).rejects.toMatchObject({ status: 0 });
    expect(f.prepare).toHaveBeenCalledWith("final-id", undefined);
    expect(f.state).toHaveBeenCalledWith("final-id", undefined);
    expect(f.harness).toHaveBeenCalledWith("final-id", undefined);
});
