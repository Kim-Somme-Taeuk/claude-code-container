import { afterEach, describe, expect, it, vi } from "vitest";
import type { createRequestedToolSetup } from "../../application/requested-tool-setup.js";
import type { SpawnSyncReturns } from "child_process";

afterEach(() => {
    vi.doUnmock("child_process");
    vi.doUnmock("../../application/requested-tool-setup.js");
    vi.restoreAllMocks();
    vi.resetModules();
});

function result(status = 0, stdout = ""): SpawnSyncReturns<string> {
    return { status, stdout, stderr: "", pid: 1, output: [], signal: null };
}

async function loadFacade() {
    const spawn = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
    const exec = vi.fn(() => { throw new Error("unexpected native exec"); });
    const factory = vi.fn<typeof createRequestedToolSetup>();
    vi.doMock("child_process", async importOriginal => ({
        ...await importOriginal<object>(), spawnSync: spawn, execSync: exec,
    }));
    // Instrument the composition call while retaining the actual policy.
    vi.doMock("../../application/requested-tool-setup.js", async importOriginal => {
        const actual = await importOriginal<typeof import("../../application/requested-tool-setup.js")>();
        factory.mockImplementation(actual.createRequestedToolSetup);
        return { ...actual, createRequestedToolSetup: factory };
    });
    vi.resetModules();
    const setup = await import("../../container-setup.js");
    const runtime = await import("../../container-runtime.js");
    const registry = await import("../../tool-registry.js");
    return { setup, runtime, registry, spawn, exec, factory };
}

describe("requested tool setup production facade", () => {
    it("imports without constructing the policy or executing native commands", async () => {
        const { spawn, exec, factory } = await loadFacade();
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
    });

    it.each(["claude", "gemini", "codex"])("keeps real %s helpers and selects the runtime when probing", async name => {
        const { setup, runtime, registry, spawn, exec, factory } = await loadFacade();
        runtime._setRuntimeInfoForTest({ runtime: "docker" });
        const target = "target with spaces";
        const original = registry.getToolByName(name)!;
        spawn.mockImplementation(() => {
            if (spawn.mock.calls.length === 1) {
                runtime._setRuntimeInfoForTest({ runtime: "podman" });
                return result(0, name === "claude" ? "VALID\n" : "");
            }
            return result();
        });
        try {
            expect(setup.ensureTools(target, original)).toBeUndefined();
            expect(factory).toHaveBeenCalledTimes(1);
            const bindings = factory.mock.calls[0][0];
            expect(bindings.ensureClaudeLauncher).toBe(setup.ensureClaudeInContainer);
            for (const binding of Object.values(bindings)) expect(typeof binding).toBe("function");
            expect(spawn.mock.calls[0][0]).toBe("docker");
            expect(spawn.mock.calls[0][1]).toEqual(name === "claude"
                ? ["exec", target, "sh", "-c", expect.stringContaining(setup.CLAUDE_BIN_PATH)]
                : ["exec", target, "sh", "-c", `[ -x /home/ccc/.local/bin/${name} ] || echo ${name}`]);
            const launcherPath = name === "claude" ? setup.CLAUDE_BIN_PATH : `/home/ccc/.local/bin/${original.binary}`;
            expect(spawn.mock.calls[1]).toEqual(["podman", ["exec", target, "test", "-x", launcherPath],
                { stdio: "ignore", timeout: setup.CONTAINER_TOOL_PROBE_TIMEOUT_MS }]);
            expect(spawn).toHaveBeenCalledTimes(name === "codex" ? 3 : 2);
            if (name === "codex") {
                expect(spawn.mock.calls[2]).toEqual(["podman", ["exec", target, "timeout", "-k", "2s", "8s", "sh", "-c",
                    "command -v bwrap >/dev/null 2>&1 || exit 42; exec bwrap --version"],
                { stdio: "ignore", timeout: setup.CONTAINER_TOOL_PROBE_TIMEOUT_MS }]);
            }
            expect(exec).not.toHaveBeenCalled();
            // Each public invocation composes anew rather than retaining ports or runtime.
            spawn.mockClear();
            spawn.mockImplementation(() => result(0, name === "claude" ? "VALID\n" : ""));
            setup.ensureTools(target, original);
            expect(factory).toHaveBeenCalledTimes(2);
            expect(factory.mock.calls[1][0]).not.toBe(bindings);
            expect(spawn.mock.calls[0][0]).toBe("podman");
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });

    it.each([
        { observation: { status: 124 }, message: "Requested tool codex is unavailable after setup" },
        { observation: { status: null, error: { code: "ETIMEDOUT" } }, message: "Requested tool codex readiness check timed out" },
    ])("passes the raw readiness observation to the real policy ($message)", async ({ observation, message }) => {
        const { setup, runtime, registry, spawn } = await loadFacade();
        runtime._setRuntimeInfoForTest({ runtime: "docker" });
        spawn.mockReturnValueOnce(result()).mockReturnValueOnce({ ...result(), ...observation } as SpawnSyncReturns<string>);
        try {
            expect(() => setup.ensureTools("target", registry.getToolByName("codex")!)).toThrow(message);
            expect(spawn).toHaveBeenCalledTimes(2);
            expect(spawn.mock.calls[1]).toEqual(["docker", ["exec", "target", "test", "-x", "/home/ccc/.local/bin/codex"],
                { stdio: "ignore", timeout: setup.CONTAINER_TOOL_PROBE_TIMEOUT_MS }]);
        } finally {
            runtime._resetRuntimeCacheForTest();
        }
    });
});
