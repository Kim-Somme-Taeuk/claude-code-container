import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), filesystem: vi.fn() }));
vi.mock("child_process", async original => {
    const actual = await original<typeof import("node:child_process")>();
    const blocked = () => { throw new Error("Forbidden fixture process"); };
    return { ...actual, spawnSync: native.spawn, spawn: blocked, exec: blocked,
        execFile: blocked, execSync: blocked, execFileSync: blocked, fork: blocked };
});
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const blocked = () => { native.filesystem(); throw new Error("Forbidden fixture filesystem effect"); };
    return {
        ...actual,
        ...Object.fromEntries(Object.entries(actual).filter(([, value]) => typeof value === "function").map(([name]) => [name, blocked])),
        promises: Object.fromEntries(Object.keys(actual.promises).map(name => [name, blocked])),
        readFileSync: (selected: unknown) => {
            if (selected instanceof URL && selected.href === new URL("../../../packages/device-lab/package.json", import.meta.url).href) {
                return JSON.stringify({ version: "0.0.0-fixture" });
            }
            return blocked();
        },
    };
});
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(),
    homedir: () => process.platform === "win32" ? "C:\\ccc-codex-config-fake\\home" : "/ccc-codex-config-fake/home",
    tmpdir: () => process.platform === "win32" ? "C:\\ccc-codex-config-fake\\temp" : "/ccc-codex-config-fake/temp",
}));

// Public Docker facade, application and runtime cache remain real.
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const stages = ["probe", "repair", "finalize"] as const;
type Stage = typeof stages[number];
type Observation = { status: number | null; error?: unknown };
const scripts = {
    probe: "timeout -k 2s 10s sh -c 'if [ -L /home/ccc/.codex/config.toml ] || { [ -e /home/ccc/.codex/config.toml ] && [ ! -f /home/ccc/.codex/config.toml ]; }; then exit 42; fi; test ! -e /home/ccc/.codex/config.toml || test -r /home/ccc/.codex/config.toml -a -w /home/ccc/.codex/config.toml'",
    repair: "timeout -k 2s 10s sh -c 'if [ -e /home/ccc/.codex/config.toml ] || [ -L /home/ccc/.codex/config.toml ]; then chown -h ccc:docker /home/ccc/.codex/config.toml 2>/dev/null || chown -h ccc:ccc /home/ccc/.codex/config.toml; fi'",
    finalize: "timeout -k 2s 10s sh -c 'if [ -L /home/ccc/.codex/config.toml ] || { [ -e /home/ccc/.codex/config.toml ] && [ ! -f /home/ccc/.codex/config.toml ]; }; then exit 42; fi; if [ -e /home/ccc/.codex/config.toml ]; then chmod 600 /home/ccc/.codex/config.toml && test -r /home/ccc/.codex/config.toml -a -w /home/ccc/.codex/config.toml; fi'",
};
const call = (stage: Stage, cli = "docker", target = "pinned target;$(ignored)") => [cli,
    ["exec", ...(stage === "repair" ? ["--user", "root"] : []), target, "sh", "-c", scripts[stage]],
    { stdio: "ignore", timeout: 15_000 },
];
function diagnostic(stage: Stage, timeout = false) {
    return `Codex config ${stage === "probe" ? "access probe" : "repair"} ${timeout ? "timed out" : "failed"}`;
}
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}
function setup(selected?: Stage, observation?: Observation) {
    for (const stage of stages) {
        native.spawn.mockImplementationOnce((...args: unknown[]) => {
            expect(args).toEqual(call(stage));
            return stage === selected ? observation : { status: stage === "probe" ? 1 : 0 };
        });
    }
}
beforeEach(() => {
    vi.resetAllMocks();
    runtime._setRuntimeInfoForTest({ runtime: "docker" });
    native.spawn.mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
});
afterEach(() => {
    expect(native.filesystem).not.toHaveBeenCalled();
    runtime._resetRuntimeCacheForTest();
    vi.restoreAllMocks();
});

// Compile-only calls preserve public void while the application returns undefined.
function compilePublicContract() {
    const result: void = docker.prepareCodexConfigForContainer("target");
    // @ts-expect-error The established facade declares void, not undefined.
    const narrowed: undefined = docker.prepareCodexConfigForContainer("target");
    // @ts-expect-error The public facade is synchronous.
    const promise: Promise<void> = docker.prepareCodexConfigForContainer("target");
    // @ts-expect-error The target is required.
    docker.prepareCodexConfigForContainer();
    // @ts-expect-error The target must be a string.
    docker.prepareCodexConfigForContainer(1);
    void [result, narrowed, promise];
}
void compilePublicContract;

describe("Codex config preparation actual public facade", () => {
    it.each(["docker", "podman"] as const)("dispatches only one unprivileged %s probe on access success", cli => {
        runtime._setRuntimeInfoForTest({ runtime: cli });
        native.spawn.mockImplementationOnce((...args: unknown[]) => {
            expect(args).toEqual(call("probe", cli));
            return { status: 0, get error(): unknown { throw new Error("unobserved error"); } };
        });
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([call("probe", cli)]);
    });
    it("preserves exact native commands, timeouts, target argv and privilege separation", () => {
        setup();
        expect(docker.CODEX_CONFIG_PREPARE_TIMEOUT_MS).toBe(15_000);
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual(stages.map(stage => call(stage)));
        expect(scripts.repair).not.toContain("chmod");
        expect(scripts.repair).toContain("chown -h ccc:docker");
        expect(scripts.repair).toContain("chown -h ccc:ccc");
        expect(scripts.finalize).toContain("chmod 600");
        expect(scripts.finalize).toContain("[ -L /home/ccc/.codex/config.toml ]");
    });
    it("selects the real runtime cache separately for each native effect", () => {
        const clis = ["docker", "podman", "docker"] as const;
        stages.forEach((stage, index) => native.spawn.mockImplementationOnce((...args: unknown[]) => {
            expect(args).toEqual(call(stage, clis[index]));
            runtime._setRuntimeInfoForTest({ runtime: clis[(index + 1) % clis.length]! });
            return { status: stage === "probe" ? 1 : 0 };
        }));
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual(stages.map((stage, index) => call(stage, clis[index])));
    });
    it.each(stages)("stops after all returned %s timeout and failure classes", stage => {
        const outcomes: Array<[Observation, boolean]> = [
            [{ status: null, error: { code: "ETIMEDOUT" } }, true], [{ status: 124 }, true], [{ status: 137 }, true],
            [{ status: null }, false], [{ status: -1 }, false], [{ status: 42 }, false],
            [{ status: stage === "probe" ? 1 : 0, error: { code: "ENOENT" } }, false],
            [{ status: stage === "probe" ? 1 : 0, error: true }, false],
        ];
        if (stage !== "probe") outcomes.push([{ status: 1 }, false], [{ status: 0, error: { code: "ETIMEDOUT" } }, true]);
        for (const [observation, timeout] of outcomes) {
            native.spawn.mockReset().mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
            setup(stage, observation);
            expect(() => docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toThrow(diagnostic(stage, timeout));
            expect(native.spawn.mock.calls).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(selected => call(selected)));
        }
    });
    it("passes raw observations with changing getters through the actual facade", () => {
        const trace: string[] = [];
        for (const stage of stages) {
            let statusReads = 0; let errorReads = 0;
            native.spawn.mockImplementationOnce((...args: unknown[]) => {
                expect(args).toEqual(call(stage)); trace.push(stage);
                return {
                    get status() { trace.push(`${stage}:status:${++statusReads}`); return stage === "probe" ? (statusReads === 1 ? 2 : 1) : 0; },
                    get error() { trace.push(`${stage}:error:${++errorReads}`); return errorReads === 1 ? {
                        get code() { trace.push(`${stage}:code`); return undefined; },
                    } : undefined; },
                };
            });
        }
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(trace).toEqual([
            "probe", "probe:status:1", "probe:error:1", "probe:code", "probe:status:2", "probe:status:3", "probe:error:2", "probe:status:4", "probe:status:5",
            "repair", "repair:error:1", "repair:code", "repair:status:1", "repair:status:2", "repair:error:2", "repair:status:3",
            "finalize", "finalize:error:1", "finalize:code", "finalize:status:1", "finalize:status:2", "finalize:error:2", "finalize:status:3",
        ]);
    });
    it.each(stages)("ignores every unrelated %s native field", stage => {
        const observation: Observation = { status: stage === "probe" ? 1 : 0 };
        for (const field of ["stdout", "stderr", "signal", "output", "pid", "then"]) Object.defineProperty(observation, field, {
            get() { throw new Error(`unobserved ${field}`); },
        });
        setup(stage, observation);
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual(stages.map(selected => call(selected)));
    });
    it.each(stages)("preserves native and observed getter exception identities at %s", stage => {
        const observations = stage === "probe"
            ? ["dispatch", "status:1", "error:1", "code", "status:2", "status:3", "error:2", "status:4", "status:5"]
            : ["dispatch", "error:1", "code", "status:1", "status:2", "error:2", "status:3"];
        for (const step of observations) for (const failure of [new Error(step), { step }]) {
            native.spawn.mockReset().mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
            const trace: string[] = []; let statusReads = 0; let errorReads = 0;
            const visit = (name: string) => { trace.push(name); if (step === name) throw failure; };
            for (const selected of stages) native.spawn.mockImplementationOnce((...args: unknown[]) => {
                expect(args).toEqual(call(selected));
                if (selected !== stage) return { status: selected === "probe" ? 1 : 0 };
                visit("dispatch"); return {
                    get status() { visit(`status:${++statusReads}`); return stage === "probe" ? 1 : 0; },
                    get error() { visit(`error:${++errorReads}`); return errorReads === 1 ? { get code() { visit("code"); return undefined; } } : undefined; },
                };
            });
            expect(thrown(() => docker.prepareCodexConfigForContainer("pinned target;$(ignored)"))).toBe(failure);
            expect(trace).toEqual(observations.slice(0, observations.indexOf(step) + 1));
            expect(native.spawn.mock.calls).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(selected => call(selected)));
        }
    });
    it("keeps singleton calls independent after partial failure", () => {
        setup("finalize", { status: 42 });
        expect(() => docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toThrow("Codex config repair failed");
        setup("probe", { status: 0 });
        expect(docker.prepareCodexConfigForContainer("pinned target;$(ignored)")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([...stages.map(stage => call(stage)), call("probe")]);
    });
});
