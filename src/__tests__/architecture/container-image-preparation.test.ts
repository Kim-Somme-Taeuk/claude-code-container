import { describe, expect, it } from "vitest";
import { createContainerImagePreparation } from "../../application/container-image-preparation.js";
import type {
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
} from "../../ports/container-image-preparation.js";

const names = [
    "exists", "label", "qualify", "pull", "tag", "reportStale", "reportPull",
    "reportFallback", "reportFailure", "reportBuildHint", "exitFailure",
] as const;
const ref = "docker.io/team/image:1.2.3";
// Expected reads/effects come from the original ensureImage and PLAN's lazy request schedule.
const missing = ["exists", "version", "reportPull:1.2.3", "registryImage", "version", "qualify:team/image:1.2.3", `pull:${ref}`];
const stale = ["exists", "imageName", "label:ccc:cli.version", "version", "version", "reportStale:0.9.0:1.2.3", "registryImage", "version", "qualify:team/image:1.2.3", `pull:${ref}`];
const scenarios = [
    { name: "development", exists: true, label: null, pull: true, trace: ["exists", "imageName", "label:ccc:cli.version"] },
    { name: "matching", exists: true, label: "1.2.3", pull: true, trace: ["exists", "imageName", "label:ccc:cli.version", "version"] },
    { name: "stale success", exists: true, label: "0.9.0", pull: true, trace: [...stale, "imageName", `tag:${ref}:ccc`] },
    { name: "empty label", exists: true, label: "", pull: true, trace: [...stale.map(event => event === "reportStale:0.9.0:1.2.3" ? "reportStale::1.2.3" : event), "imageName", `tag:${ref}:ccc`] },
    { name: "missing success", exists: false, label: "unused", pull: true, trace: [...missing, "imageName", `tag:${ref}:ccc`] },
    { name: "stale fallback", exists: true, label: "0.9.0", pull: false, trace: [...stale, `reportFallback:${ref}`] },
    { name: "missing failure", exists: false, label: "unused", pull: false, trace: [...missing, `reportFailure:${ref}`, "reportBuildHint", "exitFailure"] },
] as const;

function fixture(localExists = false, label: string | null = "0.9.0", pull = true) {
    const trace: string[] = [];
    const state = { localExists, label, pull, imageName: "ccc", version: "1.2.3", registryImage: "team/image" };
    const effect = (event: string): undefined => { trace.push(event); return undefined; };
    const ports: ContainerImagePreparationPorts = {
        exists() { trace.push("exists"); return state.localExists; },
        label(image, key) { trace.push(`label:${image}:${key}`); return state.label; },
        qualify(remote) { trace.push(`qualify:${remote}`); return `docker.io/${remote}`; },
        pull(remote) { trace.push(`pull:${remote}`); return state.pull; },
        tag(source, target) { return effect(`tag:${source}:${target}`); },
        reportStale(value, version) { return effect(`reportStale:${value}:${version}`); },
        reportPull(version) { return effect(`reportPull:${version}`); },
        reportFallback(remote) { return effect(`reportFallback:${remote}`); },
        reportFailure(remote) { return effect(`reportFailure:${remote}`); },
        reportBuildHint() { return effect("reportBuildHint"); },
        exitFailure() { return effect("exitFailure"); },
    };
    const request: ContainerImagePreparationRequest = {
        get imageName() { trace.push("imageName"); return state.imageName; },
        get version() { trace.push("version"); return state.version; },
        get registryImage() { trace.push("registryImage"); return state.registryImage; },
    };
    return { ports, request, state, trace, app: createContainerImagePreparation(ports) };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

describe("image preparation required synchronous capabilities", () => {
    it("constructs purely and rejects every missing or noncallable capability before effects", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        for (const name of names) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                const error = thrown(() => createContainerImagePreparation({ ...f.ports, [name]: invalid } as unknown as ContainerImagePreparationPorts));
                expect(error).toBeInstanceOf(TypeError);
                expect((error as Error).message).toBe(`Container image preparation requires a callable ${name} port.`);
            }
            const incomplete = { ...f.ports };
            Reflect.deleteProperty(incomplete, name);
            expect(() => createContainerImagePreparation(incomplete)).toThrow(TypeError);
        }
        for (const absent of [undefined, null]) {
            expect(() => createContainerImagePreparation(absent as unknown as ContainerImagePreparationPorts)).toThrow(TypeError);
        }
        expect(f.trace).toEqual([]);
    });

    it("validates method getters once in declaration order without invoking capabilities or reading facts", () => {
        const f = fixture();
        const reads: string[] = [];
        for (const name of names) {
            const original = f.ports[name];
            Object.defineProperty(f.ports, name, { get() { reads.push(name); return original; } });
        }
        createContainerImagePreparation(f.ports);
        expect(reads).toEqual(names);
        expect(f.trace).toEqual([]);
    });

    for (const name of names) {
        it.each([new Error("validation getter"), { validation: true }])(
            `preserves ${name} validation getter failure before any effect: %s`, failure => {
                const f = fixture();
                const reads: string[] = [];
                for (const candidate of names) {
                    const original = f.ports[candidate];
                    Object.defineProperty(f.ports, candidate, {
                        get() {
                            reads.push(candidate);
                            if (candidate === name) throw failure;
                            return original;
                        },
                    });
                }
                expect(thrown(() => createContainerImagePreparation(f.ports))).toBe(failure);
                expect(reads).toEqual(names.slice(0, names.indexOf(name) + 1));
                expect(f.trace).toEqual([]);
            },
        );
    }

    it("keeps independent instances and repeats observations on every run", () => {
        const first = fixture(true, null);
        const second = fixture(false, "unused", false);
        first.app.run(first.request);
        second.app.run(second.request);
        first.app.run(first.request);
        expect(first.trace).toEqual([...scenarios[0].trace, ...scenarios[0].trace]);
        expect(second.trace).toEqual(scenarios[6].trace);
    });
});

describe("image preparation original branches and lazy facts", () => {
    it.each(scenarios)("preserves $name reads, effects and undefined return", scenario => {
        const f = fixture(scenario.exists, scenario.label, scenario.pull);
        expect(f.app.run(f.request)).toBeUndefined();
        expect(f.trace).toEqual(scenario.trace);
    });

    it("rereads changing version/image facts at the original decision and effect points", () => {
        const f = fixture(true);
        const versions = ["compare", "diagnostic", "pull-tag"];
        Object.defineProperty(f.request, "version", {
            get() { const value = versions.shift(); f.trace.push(`version:${value}`); return value; },
        });
        f.ports.reportStale = (label, version) => {
            f.trace.push(`reportStale:${label}:${version}`);
            f.state.imageName = "replacement-target";
            f.state.registryImage = "replacement/registry";
            return undefined;
        };
        f.app.run(f.request);
        expect(f.trace).toEqual([
            "exists", "imageName", "label:ccc:cli.version", "version:compare", "version:diagnostic",
            "reportStale:0.9.0:diagnostic", "registryImage", "version:pull-tag",
            "qualify:replacement/registry:pull-tag", "pull:docker.io/replacement/registry:pull-tag",
            "imageName", "tag:docker.io/replacement/registry:pull-tag:replacement-target",
        ]);
    });

    it.each([false, true])("retains original existence and captured qualified reference after failed pull, local=%s", local => {
        const f = fixture(local, "0.9.0", false);
        const original = f.ports.pull;
        f.ports.pull = function (remote) {
            const result = original.call(this, remote);
            f.state.localExists = !local;
            f.state.registryImage = "changed";
            f.state.version = "changed";
            f.ports.qualify = () => { throw new Error("must not requalify"); };
            return result;
        };
        expect(f.app.run(f.request)).toBeUndefined();
        expect(f.trace).toEqual(local ? scenarios[5].trace : scenarios[6].trace);
    });
});

describe("image preparation exact exception and stop boundaries", () => {
    for (const scenario of scenarios) {
        for (const name of names) {
            const index = scenario.trace.findIndex(event => event === name || event.startsWith(`${name}:`));
            if (index < 0) continue;
            it.each([new Error("original"), { original: true }, "original", null, undefined])(
                `${scenario.name}: propagates ${name} thrown value %s`, failure => {
                    const f = fixture(scenario.exists, scenario.label, scenario.pull);
                    Object.assign(f.ports, { [name]: () => { throw failure; } });
                    expect(thrown(() => f.app.run(f.request))).toBe(failure);
                    expect(f.trace).toEqual(scenario.trace.slice(0, index));
                },
            );
        }
        for (const fact of ["imageName", "version", "registryImage"] as const) {
            const positions = scenario.trace.flatMap((event, index) => event === fact ? [index] : []);
            positions.forEach((position, occurrence) => {
                it.each([new Error("getter"), { getter: true }])(
                    `${scenario.name}: preserves ${fact} getter failure at read ${occurrence + 1}: %s`, failure => {
                        const f = fixture(scenario.exists, scenario.label, scenario.pull);
                        let reads = 0;
                        Object.defineProperty(f.request, fact, {
                            get() {
                                if (reads++ === occurrence) throw failure;
                                f.trace.push(fact);
                                return f.state[fact];
                            },
                        });
                        expect(thrown(() => f.app.run(f.request))).toBe(failure);
                        expect(f.trace).toEqual(scenario.trace.slice(0, position));
                    },
                );
            });
        }
    }
});

describe("image preparation live method lookup and receiver", () => {
    for (const scenario of scenarios) {
        const invoked = names.filter(name => scenario.trace.some(event => event === name || event.startsWith(`${name}:`)));
        for (const name of invoked) {
            it(`${scenario.name}: looks up current ${name} method with its receiver`, () => {
                const f = fixture(scenario.exists, scenario.label, scenario.pull);
                const original = f.ports[name];
                let lookups = 0;
                Object.defineProperty(f.ports, name, {
                    get() {
                        lookups++;
                        return function (this: ContainerImagePreparationPorts, ...args: unknown[]) {
                            expect(this).toBe(f.ports);
                            return Reflect.apply(original, this, args);
                        };
                    },
                });
                f.app.run(f.request);
                expect(lookups).toBe(1);
                expect(f.trace).toEqual(scenario.trace);
            });

            it.each([new Error("method getter"), { methodGetter: true }])(
                `${scenario.name}: propagates ${name} method getter failure %s`, failure => {
                    const f = fixture(scenario.exists, scenario.label, scenario.pull);
                    Object.defineProperty(f.ports, name, { get() { throw failure; } });
                    expect(thrown(() => f.app.run(f.request))).toBe(failure);
                    const callIndex = scenario.trace.findIndex(event => event === name || event.startsWith(`${name}:`));
                    // JavaScript resolves the method before evaluating argument getters.
                    let stop = callIndex;
                    while (stop > 0 && ["imageName", "version", "registryImage"].includes(scenario.trace[stop - 1])) stop--;
                    // The comparison's version read precedes lookup of reportStale.
                    if (name === "reportStale") stop++;
                    expect(f.trace).toEqual(scenario.trace.slice(0, stop));
                },
            );
        }
    }

    it.each([true, false])("observes downstream replacements made inside callbacks, success=%s", success => {
        const f = fixture(true, "0.9.0", success);
        const path: Array<keyof ContainerImagePreparationPorts> = success
            ? ["exists", "label", "reportStale", "qualify", "pull", "tag"]
            : ["exists", "label", "reportStale", "qualify", "pull", "reportFallback"];
        const calls: string[] = [];
        function replace(index: number): void {
            const name = path[index];
            const original = f.ports[name];
            Object.assign(f.ports, { [name]: function (this: ContainerImagePreparationPorts, ...args: unknown[]) {
                expect(this).toBe(f.ports);
                calls.push(name);
                if (index + 1 < path.length) replace(index + 1);
                return Reflect.apply(original, this, args);
            } });
        }
        replace(0);
        f.app.run(f.request);
        expect(calls).toEqual(path);
        expect(f.trace).toEqual(success ? scenarios[2].trace : scenarios[5].trace);
    });

    it("looks up the replaced failure hint and returning exit only after the preceding report", () => {
        const f = fixture(false, "unused", false);
        f.ports.reportFailure = function (remote) {
            expect(this).toBe(f.ports);
            f.trace.push(`reportFailure:${remote}`);
            this.reportBuildHint = function () {
                expect(this).toBe(f.ports);
                f.trace.push("replacement-hint");
                this.exitFailure = function () { expect(this).toBe(f.ports); f.trace.push("replacement-exit"); return undefined; };
                return undefined;
            };
            return undefined;
        };
        expect(f.app.run(f.request)).toBeUndefined();
        expect(f.trace).toEqual([...missing, `reportFailure:${ref}`, "replacement-hint", "replacement-exit"]);
    });
});
