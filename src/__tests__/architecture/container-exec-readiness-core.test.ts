import { describe, expect, it } from "vitest";
import { createContainerExecReadiness } from "../../application/container-exec-readiness.js";
import type { ContainerExecReadinessPorts } from "../../ports/container-exec-readiness.js";

const capabilities = ["now", "canExec", "sleep"] as const;
const target = " selected-container/id ";
const n = (value: number) => ["now", value];
const p = (timeout: number) => ["canExec", target, timeout];
const s = (duration: number) => ["sleep", duration];

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

function fixture(times: number[], outcomes: boolean[]) {
    const trace: unknown[][] = [];
    let clocks = 0;
    let probes = 0;
    const ports: ContainerExecReadinessPorts = {
        now() {
            if (clocks >= times.length) throw new Error("Unexpected clock read");
            const value = times[clocks++];
            trace.push(n(value));
            return value;
        },
        canExec(selected, timeout) {
            if (probes >= outcomes.length) throw new Error("Unexpected exec probe");
            trace.push(["canExec", selected, timeout]);
            return outcomes[probes++];
        },
        sleep(duration) { trace.push(s(duration)); return undefined; },
    };
    return { trace, ports };
}

describe("container exec readiness capabilities", () => {
    it("reads capabilities in order without invoking any", () => {
        const f = fixture([], []);
        const reads: string[] = [];
        const observed = {} as ContainerExecReadinessPorts;
        for (const name of capabilities) {
            Object.defineProperty(observed, name, {
                get() { reads.push(name); return f.ports[name]; },
            });
        }
        createContainerExecReadiness(observed);
        expect(reads).toEqual(capabilities);
        expect(f.trace).toEqual([]);
    });

    it.each(capabilities)("rejects malformed %s before later getters or effects", name => {
        for (const invalid of [undefined, null, false, 1, "function", {}, Promise.resolve(undefined)]) {
            const f = fixture([], []);
            const reads: string[] = [];
            const observed = {} as ContainerExecReadinessPorts;
            for (const capability of capabilities) {
                Object.defineProperty(observed, capability, {
                    get() { reads.push(capability); return capability === name ? invalid : f.ports[capability]; },
                });
            }
            const error = thrown(() => createContainerExecReadiness(observed));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toBe(`Container exec readiness requires a callable ${name} port.`);
            expect(reads).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
            expect(f.trace).toEqual([]);
        }
    });

    it("rejects absent ports with the first diagnostic", () => {
        for (const invalid of [undefined, null, {}]) {
            expect(() => createContainerExecReadiness(invalid as unknown as ContainerExecReadinessPorts))
                .toThrow("Container exec readiness requires a callable now port.");
        }
    });

    it.each(capabilities)("preserves Error and non-Error failures from the %s getter", name => {
        for (const failure of [new Error("getter failure"), { failure: name }]) {
            const f = fixture([], []);
            const reads: string[] = [];
            const observed = {} as ContainerExecReadinessPorts;
            for (const capability of capabilities) {
                Object.defineProperty(observed, capability, {
                    get() {
                        reads.push(capability);
                        if (capability === name) throw failure;
                        return f.ports[capability];
                    },
                });
            }
            expect(thrown(() => createContainerExecReadiness(observed))).toBe(failure);
            expect(reads).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
            expect(f.trace).toEqual([]);
        }
    });
});

describe("container exec readiness policy traces", () => {
    const cases = [
        { name: "initial expiry", times: [100, 850], outcomes: [], result: false,
            trace: [n(100), n(850)] },
        { name: "initial negative budget", times: [100, 851], outcomes: [], result: false,
            trace: [n(100), n(851)] },
        { name: "immediate success", times: [100, 101], outcomes: [true], result: true,
            trace: [n(100), n(101), p(200)] },
        { name: "second attempt success", times: [100, 101, 110, 185], outcomes: [false, true], result: true,
            trace: [n(100), n(101), p(200), n(110), s(75), n(185), p(200)] },
        { name: "third attempt success", times: [100, 101, 110, 185, 190, 265], outcomes: [false, false, true], result: true,
            trace: [n(100), n(101), p(200), n(110), s(75), n(185), p(200), n(190), s(75), n(265), p(200)] },
        { name: "exhaustion retains final post-failure clock without a third pause", times: [100, 101, 110, 185, 190, 265, 270], outcomes: [false, false, false], result: false,
            trace: [n(100), n(101), p(200), n(110), s(75), n(185), p(200), n(190), s(75), n(265), p(200), n(270)] },
        { name: "expiry after a pause", times: [100, 101, 110, 850], outcomes: [false], result: false,
            trace: [n(100), n(101), p(200), n(110), s(75), n(850)] },
        { name: "shrinking timeout and pause budgets", times: [0, 600, 700, 725, 740, 749, 750], outcomes: [false, false, false], result: false,
            trace: [n(0), n(600), p(150), n(700), s(50), n(725), p(25), n(740), s(10), n(749), p(1), n(750)] },
        { name: "fractional budgets stay unrounded", times: [0.5, 550.75, 700.25, 750.25], outcomes: [false, true], result: true,
            trace: [n(0.5), n(550.75), p(199.75), n(700.25), s(50.25), n(750.25), p(0.25)] },
        { name: "zero pause is skipped", times: [0, 0, 750, 751], outcomes: [false], result: false,
            trace: [n(0), n(0), p(200), n(750), n(751)] },
        { name: "negative pause is skipped", times: [0, 0, 800, 801], outcomes: [false], result: false,
            trace: [n(0), n(0), p(200), n(800), n(801)] },
        { name: "forward jump expires the next attempt", times: [100, 101, 900, 901], outcomes: [false], result: false,
            trace: [n(100), n(101), p(200), n(900), n(901)] },
        { name: "backward jumps preserve caps and three-attempt bound", times: [100, -100, -200, -300, -400, -500, -600], outcomes: [false, false, false], result: false,
            trace: [n(100), n(-100), p(200), n(-200), s(75), n(-300), p(200), n(-400), s(75), n(-500), p(200), n(-600)] },
        { name: "backward jump permits retry after a skipped pause", times: [0, 0, 800, 700], outcomes: [false, true], result: true,
            trace: [n(0), n(0), p(200), n(800), n(700), p(50)] },
    ];

    it.each(cases)("$name", ({ times, outcomes, result, trace }) => {
        const f = fixture(times, outcomes);
        expect(createContainerExecReadiness(f.ports).run(target)).toBe(result);
        expect(f.trace).toEqual(trace);
    });

    it("accepts a successful probe that moves the clock beyond the deadline without another read", () => {
        const trace: unknown[][] = [];
        let current = 0;
        const app = createContainerExecReadiness({
            now() { trace.push(n(current)); return current; },
            canExec(selected, timeout) {
                trace.push(["canExec", selected, timeout]);
                current = 1000;
                return true;
            },
            sleep(duration) { trace.push(s(duration)); return undefined; },
        });
        expect(app.run(target)).toBe(true);
        expect(current).toBe(1000);
        expect(trace).toEqual([n(0), n(0), p(200)]);
    });

    it("uses live replacements with the ports receiver and independent deadlines on repeat runs", () => {
        const f = fixture([], []);
        const app = createContainerExecReadiness(f.ports);
        let clockReads = 0;
        f.ports.now = function () {
            expect(this).toBe(f.ports);
            const value = [0, 0, 10][clockReads++];
            f.trace.push(n(value));
            return value;
        };
        f.ports.canExec = function (selected, timeout) {
            expect(this).toBe(f.ports);
            f.trace.push(["canExec", selected, timeout]);
            this.sleep = function (duration) {
                expect(this).toBe(f.ports);
                f.trace.push(s(duration));
                this.now = function () { expect(this).toBe(f.ports); f.trace.push(n(20)); return 20; };
                this.canExec = function (next, budget) {
                    expect(this).toBe(f.ports);
                    f.trace.push(["canExec", next, budget]);
                    return true;
                };
                return undefined;
            };
            return false;
        };
        expect(app.run(target)).toBe(true);
        expect(f.trace).toEqual([n(0), n(0), p(200), n(10), s(75), n(20), p(200)]);

        f.trace.length = 0;
        const times = [1000, 1600];
        f.ports.now = function () { expect(this).toBe(f.ports); const value = times.shift()!; f.trace.push(n(value)); return value; };
        expect(app.run("second-target")).toBe(true);
        expect(f.trace).toEqual([n(1000), n(1600), ["canExec", "second-target", 150]]);
    });
});

describe("container exec readiness failure propagation", () => {
    const steps = ["now:1", "now:2", "probe:1", "now:3", "sleep:1", "now:4", "probe:2", "now:5", "sleep:2", "now:6", "probe:3", "now:7"];

    it.each(steps)("preserves Error and non-Error at %s and suppresses later effects", step => {
        for (const failure of [new Error("operation failure"), { failure: step }]) {
            const trace: string[] = [];
            let clocks = 0;
            let probes = 0;
            let sleeps = 0;
            const visit = (name: string) => { trace.push(name); if (name === step) throw failure; };
            const app = createContainerExecReadiness({
                now() { visit(`now:${++clocks}`); return 0; },
                canExec() { visit(`probe:${++probes}`); return false; },
                sleep() { visit(`sleep:${++sleeps}`); return undefined; },
            });
            expect(thrown(() => app.run(target))).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });

    it.each(["Promise", "thenable"])("ignores hostile %s sleep returns", kind => {
        const f = fixture([0, 0, 0, 0, 0, 0, 0], [false, false, false]);
        const accesses: string[] = [];
        const ignored = kind === "Promise" ? Promise.resolve("ignored") : {};
        Object.defineProperty(ignored, "then", {
            get() { accesses.push("then"); throw new Error("must not inspect then"); },
        });
        f.ports.sleep = ((duration: number) => { f.trace.push(s(duration)); return ignored; }) as unknown as ContainerExecReadinessPorts["sleep"];
        expect(createContainerExecReadiness(f.ports).run(target)).toBe(false);
        expect(f.trace).toEqual([n(0), n(0), p(200), n(0), s(75), n(0), p(200), n(0), s(75), n(0), p(200), n(0)]);
        expect(accesses).toEqual([]);
    });
});
