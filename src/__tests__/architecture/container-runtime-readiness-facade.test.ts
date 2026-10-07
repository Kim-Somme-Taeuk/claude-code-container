import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import type { RuntimeName } from "../../domain/container-runtime.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), cli: vi.fn(), info: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(),
    runtimeCli: native.cli, getRuntimeInfo: native.info,
}));

// Both the public Docker facade and its application policy remain real.
const docker = await import("../../docker.js");
const options = { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] };
const cases: Array<[RuntimeName, string, string]> = [
    ["docker", "docker-desktop", "Please start Docker Desktop and try again."],
    ["docker", "docker-native", "Please start the docker service (e.g. `sudo systemctl start docker`) and try again."],
    ["podman", "podman-machine", "Please start the Podman machine (`podman machine start`) and try again."],
    ["podman", "podman-rootless", "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again."],
    ["podman", "podman-rootful", "Please start the Podman service (`sudo systemctl start podman.socket`) and try again."],
];

function result(status: number | null = 1, stderr = ""): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout: "", stderr, status, signal: null };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

function fixture(runtime: RuntimeName = "docker", flavor = "docker-native", status: number | null = 1, stderr = "") {
    const trace: string[] = [];
    const info = { runtime, flavor };
    native.cli.mockImplementation(() => { trace.push("cli"); return "fixture-runtime"; });
    native.spawn.mockImplementation(() => { trace.push("probe"); return result(status, stderr); });
    native.info.mockImplementation(() => { trace.push("info"); return info; });
    vi.spyOn(console, "error").mockImplementation(function (this: unknown, message) {
        expect(this).toBe(console);
        trace.push(message);
    });
    vi.spyOn(process, "exit").mockImplementation((function (this: unknown, code: unknown) {
        expect(this).toBe(process);
        trace.push(`exit:${code}`);
    }) as typeof process.exit);
    return { trace, info };
}

function assertOnlyInfoProbe() {
    expect(native.spawn.mock.calls).toEqual([["fixture-runtime", ["info"], options]]);
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DEBUG", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("container runtime readiness public facade", () => {
    it.each([0, 1, 127, null])("preserves native info probe options and status %s classification", status => {
        fixture("docker", "docker-native", status);
        expect(docker.isDockerRunning()).toBe(status === 0);
        assertOnlyInfoProbe();
        expect(native.info).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("returns undefined on readiness without facts, diagnostics or exit", () => {
        const f = fixture("docker", "docker-native", 0);
        vi.stubEnv("DEBUG", "1");
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe"]);
        assertOnlyInfoProbe();
        expect(native.info).not.toHaveBeenCalled();
    });

    it.each(cases)("prints exact %s/%s guidance and exits once without service commands", (runtime, flavor, hint) => {
        const f = fixture(runtime, flavor);
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe", "info", `Error: ${runtime} is not running.`, hint, "exit:1"]);
        expect(native.info).toHaveBeenCalledTimes(1);
        assertOnlyInfoProbe();
    });

    it.each([
        ["1", "  native failure\n", true],
        ["1", " \n\t", false],
        ["", "native failure", false],
        [undefined, "native failure", false],
    ] as const)("preserves DEBUG %s with stderr %s before refusal", (debug, stderr, visible) => {
        const f = fixture("docker", "docker-native", 1, stderr);
        vi.stubEnv("DEBUG", debug);
        docker.ensureDockerRunning();
        expect(f.trace).toEqual([
            "cli", "probe",
            ...(visible ? ["cli", "[ccc:debug] fixture-runtime info failed: native failure"] : []),
            "info", "Error: docker is not running.", cases[1][2], "exit:1",
        ]);
        assertOnlyInfoProbe();
    });

    it("looks up console and process effects late and preserves native receivers", () => {
        const f = fixture();
        const initialError = console.error;
        const initialExit = process.exit;
        const lateExit = vi.fn(function (this: unknown, code: unknown) {
            expect(this).toBe(process);
            f.trace.push(`late-exit:${code}`);
        });
        const secondError = vi.fn(function (this: unknown, message: string) {
            expect(this).toBe(console);
            f.trace.push(message);
            process.exit = lateExit as unknown as typeof process.exit;
        });
        const firstError = vi.fn(function (this: unknown, message: string) {
            expect(this).toBe(console);
            f.trace.push(message);
            console.error = secondError;
        });
        native.spawn.mockImplementation(() => {
            f.trace.push("probe");
            console.error = firstError;
            return result();
        });
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe", "info", "Error: docker is not running.", cases[1][2], "late-exit:1"]);
        expect(initialError).not.toHaveBeenCalled();
        expect(initialExit).not.toHaveBeenCalled();
        expect(firstError).toHaveBeenCalledTimes(1);
        expect(secondError).toHaveBeenCalledTimes(1);
        expect(lateExit).toHaveBeenCalledTimes(1);
        assertOnlyInfoProbe();
    });
});

describe("container runtime readiness reporter selection before interpolation", () => {
    it("uses the selected first reporter when the runtime getter replaces console.error", () => {
        const f = fixture();
        const descriptor = Object.getOwnPropertyDescriptor(console, "error")!;
        let reads = 0;
        let returned: unknown;
        const receivers: unknown[] = [];
        const replacement = function (this: unknown, message: string) {
            receivers.push(this); f.trace.push(`replacement:${message}`);
        };
        try {
            console.error = function (this: unknown, message: string) {
                receivers.push(this); f.trace.push(`original:${message}`);
            };
            Object.defineProperty(f.info, "runtime", {
                get() { reads++; f.trace.push("runtime"); console.error = replacement; return "docker"; },
            });
            returned = docker.ensureDockerRunning();
        } finally { Object.defineProperty(console, "error", descriptor); }
        expect(returned).toBeUndefined();
        expect(reads).toBe(2);
        expect(receivers).toEqual([console, console]);
        expect(f.trace).toEqual(["cli", "probe", "info", "runtime",
            "original:Error: docker is not running.", "runtime", `replacement:${cases[1][2]}`, "exit:1"]);
        assertOnlyInfoProbe();
    });

    it("lets the console.error accessor change facts before interpolating runtime", () => {
        const f = fixture();
        const descriptor = Object.getOwnPropertyDescriptor(console, "error")!;
        let runtime: RuntimeName = "docker";
        let returned: unknown;
        const receivers: unknown[] = [];
        Object.defineProperty(f.info, "runtime", {
            get() { f.trace.push("runtime"); return runtime; },
        });
        try {
            Object.defineProperty(console, "error", {
                configurable: true,
                get() {
                    f.trace.push("reporter-get");
                    runtime = "podman"; f.info.flavor = "podman-machine";
                    return function (this: unknown, message: string) {
                        receivers.push(this); f.trace.push(message);
                    };
                },
            });
            returned = docker.ensureDockerRunning();
        } finally { Object.defineProperty(console, "error", descriptor); }
        expect(returned).toBeUndefined();
        expect(receivers).toEqual([console, console]);
        expect(f.trace).toEqual(["cli", "probe", "info", "reporter-get", "runtime",
            "Error: podman is not running.", "runtime", "reporter-get", cases[2][2], "exit:1"]);
        assertOnlyInfoProbe();
    });

    it("preserves a throwing reporter accessor without interpolating runtime", () => {
        for (const failure of [new Error("reporter getter"), { reporter: true }]) {
            native.spawn.mockClear();
            const f = fixture();
            const descriptor = Object.getOwnPropertyDescriptor(console, "error")!;
            let reads = 0;
            let escaped: unknown;
            Object.defineProperty(f.info, "runtime", { get() { reads++; return "docker"; } });
            try {
                Object.defineProperty(console, "error", {
                    configurable: true,
                    get() { f.trace.push("reporter-get"); throw failure; },
                });
                escaped = thrown(() => docker.ensureDockerRunning());
            } finally { Object.defineProperty(console, "error", descriptor); }
            expect(escaped).toBe(failure);
            expect(reads).toBe(0);
            expect(f.trace).toEqual(["cli", "probe", "info", "reporter-get"]);
            expect(process.exit).not.toHaveBeenCalled();
            assertOnlyInfoProbe();
        }
    });
});

describe("container runtime readiness facade failure behavior", () => {
    const steps = ["cli", "probe", "info", "runtime:1", "report:1", "runtime:2", "flavor:1", "flavor:2", "report:2", "exit"];

    it.each(steps)("preserves Error and non-Error throws at %s and stops later effects", step => {
        for (const failure of [new Error("native failure"), { failure: step }]) {
            const f = fixture("podman", "podman-rootless");
            let runtimes = 0;
            let flavors = 0;
            let reports = 0;
            const visit = (name: string) => {
                f.trace.push(name);
                if (step === name) throw failure;
            };
            Object.defineProperties(f.info, {
                runtime: { get() { visit(`runtime:${++runtimes}`); return "podman"; } },
                flavor: { get() { visit(`flavor:${++flavors}`); return "podman-rootless"; } },
            });
            native.cli.mockImplementation(() => { visit("cli"); return "fixture-runtime"; });
            native.spawn.mockImplementation(() => { visit("probe"); return result(); });
            native.info.mockImplementation(() => { visit("info"); return f.info; });
            vi.mocked(console.error).mockImplementation(() => { visit(`report:${++reports}`); });
            vi.mocked(process.exit).mockImplementation((() => { visit("exit"); }) as typeof process.exit);
            expect(thrown(() => docker.ensureDockerRunning())).toBe(failure);
            expect(f.trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });

    it("preserves a debug-report exception before observing runtime facts", () => {
        for (const failure of [new Error("debug"), { failure: "debug" }]) {
            const f = fixture("docker", "docker-native", 1, "native failure");
            vi.stubEnv("DEBUG", "1");
            vi.mocked(console.error).mockImplementation(() => { f.trace.push("debug"); throw failure; });
            expect(thrown(() => docker.ensureDockerRunning())).toBe(failure);
            expect(f.trace).toEqual(["cli", "probe", "cli", "debug"]);
            expect(native.info).not.toHaveBeenCalled();
            expect(process.exit).not.toHaveBeenCalled();
        }
    });

    it.each(["Promise", "thenable"])("ignores hostile %s report and exit returns through the public void wrapper", kind => {
        const f = fixture();
        const accesses: string[] = [];
        const ignored = kind === "Promise" ? Promise.resolve("ignored") : {};
        Object.defineProperty(ignored, "then", {
            get() { accesses.push("then"); throw new Error("must not inspect return"); },
        });
        // Plain effects avoid Vitest's spy tracking, which observes Promise.then itself.
        console.error = message => { f.trace.push(message); return ignored; };
        process.exit = (function (code: unknown) {
            f.trace.push(`exit:${code}`);
            return ignored;
        }) as unknown as typeof process.exit;
        expect(docker.ensureDockerRunning()).toBeUndefined();
        expect(f.trace).toEqual(["cli", "probe", "info", "Error: docker is not running.", cases[1][2], "exit:1"]);
        expect(accesses).toEqual([]);
        assertOnlyInfoProbe();
    });
});
