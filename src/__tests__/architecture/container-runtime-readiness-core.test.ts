import { describe, expect, it } from "vitest";
import { createContainerRuntimeReadiness } from "../../application/container-runtime-readiness.js";
import type { RuntimeName } from "../../domain/container-runtime.js";
import type { ContainerRuntimeReadinessPorts } from "../../ports/container-runtime-readiness.js";

const capabilities = ["isRunning", "runtimeInfo", "reportError", "exitFailure"] as const;
const hints = {
    desktop: "Please start Docker Desktop and try again.",
    docker: "Please start the docker service (e.g. `sudo systemctl start docker`) and try again.",
    machine: "Please start the Podman machine (`podman machine start`) and try again.",
    rootless: "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again.",
    podman: "Please start the Podman service (`sudo systemctl start podman.socket`) and try again.",
};
const flavors = ["docker-native", "docker-rootless", "docker-desktop", "podman-rootful", "podman-rootless", "podman-machine", "unknown", "future-flavor"];

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

function fixture(runtime: RuntimeName = "podman", flavor = "podman-rootless") {
    const trace: string[] = [];
    const info = { runtime, flavor };
    const ports: ContainerRuntimeReadinessPorts = {
        isRunning: () => { trace.push("running"); return false; },
        runtimeInfo: () => { trace.push("info"); return info; },
        reportError: message => { trace.push(message()); return undefined; },
        exitFailure: () => { trace.push("exit"); return undefined; },
    };
    return { trace, info, ports };
}

describe("container runtime readiness capabilities", () => {
    it("reads required capabilities in order without invoking them", () => {
        const f = fixture();
        const observed = {} as ContainerRuntimeReadinessPorts;
        for (const name of capabilities) {
            Object.defineProperty(observed, name, {
                get() { f.trace.push(name); return f.ports[name]; },
            });
        }
        createContainerRuntimeReadiness(observed);
        expect(f.trace).toEqual(capabilities);
    });

    it.each(capabilities)("rejects malformed %s and stops before later getters or effects", name => {
        for (const invalid of [undefined, null, false, 1, "function", {}]) {
            const f = fixture();
            const observed = {} as ContainerRuntimeReadinessPorts;
            for (const capability of capabilities) {
                Object.defineProperty(observed, capability, {
                    get() {
                        f.trace.push(capability);
                        return capability === name ? invalid : f.ports[capability];
                    },
                });
            }
            const error = thrown(() => createContainerRuntimeReadiness(observed));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toBe(`Container runtime readiness requires a callable ${name} port.`);
            expect(f.trace).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
        }
    });

    it("rejects absent ports with the first capability diagnostic", () => {
        for (const invalid of [undefined, null, {}]) {
            expect(() => createContainerRuntimeReadiness(invalid as unknown as ContainerRuntimeReadinessPorts))
                .toThrow("Container runtime readiness requires a callable isRunning port.");
        }
    });

    it.each(capabilities)("preserves Error and non-Error failures from the %s getter", name => {
        for (const failure of [new Error("getter failure"), { failure: name }]) {
            const f = fixture();
            const observed = {} as ContainerRuntimeReadinessPorts;
            for (const capability of capabilities) {
                Object.defineProperty(observed, capability, {
                    get() {
                        f.trace.push(capability);
                        if (capability === name) throw failure;
                        return f.ports[capability];
                    },
                });
            }
            expect(thrown(() => createContainerRuntimeReadiness(observed))).toBe(failure);
            expect(f.trace).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
        }
    });
});

describe("container runtime readiness policy", () => {
    it("returns undefined when running without observing facts or producing effects", () => {
        const f = fixture();
        f.ports.isRunning = () => { f.trace.push("running"); return true; };
        expect(createContainerRuntimeReadiness(f.ports).run()).toBeUndefined();
        expect(f.trace).toEqual(["running"]);
    });

    for (const runtime of ["docker", "podman"] as const) {
        it.each(flavors)(`preserves ${runtime} guidance and fact reads for %s`, flavor => {
            const f = fixture(runtime, flavor);
            Object.defineProperties(f.info, {
                runtime: { get() { f.trace.push("runtime"); return runtime; } },
                flavor: { get() { f.trace.push("flavor"); return flavor; } },
            });
            const hint = runtime === "docker"
                ? flavor === "docker-desktop" ? hints.desktop : hints.docker
                : flavor === "podman-machine" ? hints.machine
                    : flavor === "podman-rootless" ? hints.rootless : hints.podman;
            const flavorReads = runtime === "docker" || flavor === "podman-machine"
                ? ["flavor"] : ["flavor", "flavor"];
            expect(createContainerRuntimeReadiness(f.ports).run()).toBeUndefined();
            expect(f.trace).toEqual([
                "running", "info", "runtime", `Error: ${runtime} is not running.`,
                "runtime", ...flavorReads, hint, "exit",
            ]);
        });
    }

    it("uses the second runtime read after the first diagnostic", () => {
        const f = fixture("docker", "podman-machine");
        let reads = 0;
        Object.defineProperty(f.info, "runtime", {
            get() { return reads++ === 0 ? "docker" : "podman"; },
        });
        createContainerRuntimeReadiness(f.ports).run();
        expect(reads).toBe(2);
        expect(f.trace).toEqual(["running", "info", "Error: docker is not running.", hints.machine, "exit"]);
    });

    it("uses the second flavor read when checking rootless Podman", () => {
        const f = fixture();
        let reads = 0;
        Object.defineProperty(f.info, "flavor", {
            get() { return reads++ === 0 ? "unknown" : "podman-rootless"; },
        });
        createContainerRuntimeReadiness(f.ports).run();
        expect(reads).toBe(2);
        expect(f.trace).toEqual(["running", "info", "Error: podman is not running.", hints.rootless, "exit"]);
    });

    it("lets reporting change facts before runtime branching", () => {
        const f = fixture("docker", "docker-desktop");
        f.ports.reportError = message => {
            f.trace.push(message());
            f.info.runtime = "podman";
            f.info.flavor = "podman-rootless";
            return undefined;
        };
        createContainerRuntimeReadiness(f.ports).run();
        expect(f.trace).toEqual(["running", "info", "Error: docker is not running.", hints.rootless, "exit"]);
    });
});

describe("container runtime readiness failure propagation", () => {
    const steps = ["running", "info", "runtime:1", "report:1", "runtime:2", "flavor:1", "flavor:2", "report:2", "exit"];

    it.each(steps)("preserves thrown values at %s and suppresses every later step", step => {
        for (const failure of [new Error("operation failure"), { failure: step }]) {
            const trace: string[] = [];
            const visit = (name: string) => {
                trace.push(name);
                if (name === step) throw failure;
            };
            let runtimeReads = 0;
            let flavorReads = 0;
            let reports = 0;
            const info = {
                get runtime(): RuntimeName { visit(`runtime:${++runtimeReads}`); return "podman"; },
                get flavor() { visit(`flavor:${++flavorReads}`); return "podman-rootless"; },
            };
            const app = createContainerRuntimeReadiness({
                isRunning: () => { visit("running"); return false; },
                runtimeInfo: () => { visit("info"); return info; },
                reportError: message => { message(); visit(`report:${++reports}`); return undefined; },
                exitFailure: () => { visit("exit"); return undefined; },
            });
            expect(thrown(() => app.run())).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });

    it.each(["Promise", "thenable"])("ignores hostile %s returns from both reports and exit", kind => {
        const f = fixture();
        const accesses: string[] = [];
        const ignored = kind === "Promise" ? Promise.resolve("ignored") : {};
        Object.defineProperty(ignored, "then", {
            get() { accesses.push("then"); throw new Error("must not inspect then"); },
        });
        f.ports.reportError = ((message: () => string) => {
            f.trace.push(message());
            return ignored;
        }) as unknown as ContainerRuntimeReadinessPorts["reportError"];
        f.ports.exitFailure = (() => {
            f.trace.push("exit");
            return ignored;
        }) as unknown as ContainerRuntimeReadinessPorts["exitFailure"];
        expect(createContainerRuntimeReadiness(f.ports).run()).toBeUndefined();
        expect(f.trace).toEqual(["running", "info", "Error: podman is not running.", hints.rootless, "exit"]);
        expect(accesses).toEqual([]);
    });
});
