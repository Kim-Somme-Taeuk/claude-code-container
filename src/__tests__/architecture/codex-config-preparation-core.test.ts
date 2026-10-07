import { describe, expect, it } from "vitest";
import { createCodexConfigPreparation } from "../../application/codex-config-preparation.js";
import type { CodexConfigPreparationPorts } from "../../ports/codex-config-preparation.js";

const stages = ["probe", "repair", "finalize"] as const;
type Stage = typeof stages[number];
type Result = ReturnType<CodexConfigPreparationPorts[Stage]>;
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}
function fixture(stage?: Stage, observation?: Result) {
    const trace: string[] = [];
    const ports: CodexConfigPreparationPorts = {
        probe(target) { expect(this).toBe(ports); trace.push(`probe:${target}`); return stage === "probe" ? observation! : { status: 1 }; },
        repair(target) { expect(this).toBe(ports); trace.push(`repair:${target}`); return stage === "repair" ? observation! : { status: 0 }; },
        finalize(target) { expect(this).toBe(ports); trace.push(`finalize:${target}`); return stage === "finalize" ? observation! : { status: 0 }; },
    };
    return { ports, trace, app: () => createCodexConfigPreparation(ports) };
}
function message(stage: Stage, timedOut = false) {
    return `Codex config ${stage === "probe" ? "access probe" : "repair"} ${timedOut ? "timed out" : "failed"}`;
}

describe("Codex config preparation construction", () => {
    it("checks capabilities in order without invoking them", () => {
        const f = fixture();
        const observed = {} as CodexConfigPreparationPorts;
        for (const stage of stages) Object.defineProperty(observed, stage, { get() { f.trace.push(stage); return f.ports[stage]; } });
        createCodexConfigPreparation(observed);
        expect(f.trace).toEqual(stages);
    });
    it.each(stages)("rejects noncallable %s before later getters", stage => {
        for (const invalid of [undefined, null, false, 0, "function", {}]) {
            const f = fixture();
            const observed = {} as CodexConfigPreparationPorts;
            for (const selected of stages) Object.defineProperty(observed, selected, { get() {
                f.trace.push(selected); return selected === stage ? invalid : f.ports[selected];
            } });
            const error = thrown(() => createCodexConfigPreparation(observed));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toBe(`Codex config preparation requires a callable ${stage} port.`);
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
        }
    });
    it("rejects absent ports at probe", () => {
        for (const invalid of [undefined, null, {}]) expect(() => createCodexConfigPreparation(invalid as CodexConfigPreparationPorts))
            .toThrow("Codex config preparation requires a callable probe port.");
    });
    it.each(stages)("preserves capability getter throws at %s", stage => {
        for (const failure of [new Error(stage), { stage }]) {
            const f = fixture();
            const observed = {} as CodexConfigPreparationPorts;
            for (const selected of stages) Object.defineProperty(observed, selected, { get() {
                f.trace.push(selected); if (selected === stage) throw failure; return f.ports[selected];
            } });
            expect(thrown(() => createCodexConfigPreparation(observed))).toBe(failure);
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
        }
    });
});

describe("Codex config preparation decisions", () => {
    it("returns on probe zero without reading error or any unrelated field", () => {
        const f = fixture("probe", { status: 0, get error(): unknown { throw new Error("unreachable"); } });
        expect(f.app().run("exact target")).toBeUndefined();
        expect(f.trace).toEqual(["probe:exact target"]);
    });
    it("repairs and finalizes in order with the exact target and no persistent state", () => {
        const f = fixture(); const app = f.app();
        expect(app.run("one")).toBeUndefined(); expect(app.run("two")).toBeUndefined();
        expect(f.trace).toEqual(["probe:one", "repair:one", "finalize:one", "probe:two", "repair:two", "finalize:two"]);
    });
    it.each(stages)("classifies all returned %s observations without replay", stage => {
        const outcomes: Array<[Result, boolean]> = [
            [{ status: null, error: { code: "ETIMEDOUT" } }, true],
            [{ status: 124 }, true], [{ status: 137 }, true],
            [{ status: null }, false], [{ status: -1 }, false], [{ status: 42 }, false],
            [{ status: stage === "probe" ? 1 : 0, error: new Error("native") }, false],
            [{ status: stage === "probe" ? 1 : 0, error: { code: "ENOENT" } }, false],
        ];
        if (stage !== "probe") outcomes.push([{ status: 1 }, false], [{ status: 0, error: { code: "ETIMEDOUT" } }, true]);
        for (const [result, timeout] of outcomes) {
            const f = fixture(stage, result);
            expect(() => f.app().run("target")).toThrow(message(stage, timeout));
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage) + 1).map(s => `${s}:target`));
        }
    });
    it.each(stages)("retains primitive/nullish and opaque %s error semantics", stage => {
        for (const error of [undefined, null, false, 0, "", NaN, true, 1, "ETIMEDOUT", Symbol("opaque"), 1n, {}, { code: 124 }]) {
            const f = fixture(stage, { status: stage === "probe" ? 1 : 0, error });
            if (error) expect(() => f.app().run("target")).toThrow(message(stage));
            else expect(f.app().run("target")).toBeUndefined();
            expect(f.trace).toEqual((error ? stages.slice(0, stages.indexOf(stage) + 1) : stages).map(s => `${s}:target`));
        }
    });
    it.each(stages)("ignores unrelated %s result fields", stage => {
        const result: Result = { status: stage === "probe" ? 1 : 0 };
        for (const field of ["stdout", "stderr", "signal", "then", "pid", "output"]) Object.defineProperty(result, field, {
            get() { throw new Error(`unreachable ${field}`); },
        });
        const f = fixture(stage, result);
        expect(f.app().run("target")).toBeUndefined();
        expect(f.trace).toEqual(stages.map(s => `${s}:target`));
    });
    it("resolves changing capabilities with their original ports receiver", () => {
        const f = fixture(); const app = f.app();
        f.ports.probe = function (target) {
            expect(this).toBe(f.ports); f.trace.push(`new-probe:${target}`);
            f.ports.repair = function (selected) {
                expect(this).toBe(f.ports); f.trace.push(`new-repair:${selected}`);
                f.ports.finalize = function (last) { expect(this).toBe(f.ports); f.trace.push(`new-finalize:${last}`); return { status: 0 }; };
                return { status: 0 };
            };
            return { status: 1 };
        };
        expect(app.run("target")).toBeUndefined();
        expect(f.trace).toEqual(["new-probe:target", "new-repair:target", "new-finalize:target"]);
    });
    it("keeps nested runs independent while an outer repair is active", () => {
        const f = fixture(); const app = f.app();
        f.ports.repair = function (target) {
            expect(this).toBe(f.ports); f.trace.push(`repair:${target}`);
            if (target === "outer") expect(app.run("inner")).toBeUndefined();
            return { status: 0 };
        };
        expect(app.run("outer")).toBeUndefined();
        expect(f.trace).toEqual(["probe:outer", "repair:outer", "probe:inner", "repair:inner", "finalize:inner", "finalize:outer"]);
    });
});

describe("Codex config preparation observation order", () => {
    it.each(stages)("keeps repeated %s status/error reads", stage => {
        const observations: string[] = [];
        const f = fixture(stage, {
            get status() { observations.push("status"); return stage === "probe" ? 1 : 0; },
            get error() { observations.push("error"); return undefined; },
        });
        expect(f.app().run("target")).toBeUndefined();
        expect(observations).toEqual(stage === "probe"
            ? ["status", "error", "status", "status", "error", "status", "status"]
            : ["error", "status", "status", "error", "status"]);
    });
    it.each(stages)("short-circuits %s timeout observations", stage => {
        for (const timeout of ["code", 124, 137] as const) {
            const observations: string[] = [];
            const f = fixture(stage, {
                get status() { observations.push("status"); return timeout === "code" ? (stage === "probe" ? 1 : 0) : timeout; },
                get error() { observations.push("error"); return { get code() { observations.push("code"); return timeout === "code" ? "ETIMEDOUT" : undefined; } }; },
            });
            expect(() => f.app().run("target")).toThrow(message(stage, true));
            expect(observations).toEqual([...(stage === "probe" ? ["status"] : []), "error", "code",
                ...(timeout === "code" ? [] : timeout === 124 ? ["status"] : ["status", "status"])]);
        }
    });
    it.each(stages)("uses changed %s status values rather than snapshots", stage => {
        let reads = 0;
        const f = fixture(stage, { get status() { return ++reads === (stage === "probe" ? 2 : 1) ? 124 : (stage === "probe" ? 1 : 0); } });
        expect(() => f.app().run("target")).toThrow(message(stage, true));
        expect(reads).toBe(stage === "probe" ? 2 : 1);
    });
    it.each(stages)("uses changed %s error values rather than snapshots", stage => {
        let reads = 0;
        const f = fixture(stage, { status: stage === "probe" ? 1 : 0, get error() { return ++reads === 1 ? undefined : { changed: true }; } });
        expect(() => f.app().run("target")).toThrow(message(stage));
        expect(reads).toBe(2);
    });
    it.each(stages)("stops %s status reads when the second error is truthy", stage => {
        const observations: string[] = []; let errorReads = 0;
        const f = fixture(stage, {
            get status() { observations.push("status"); return stage === "probe" ? 1 : 0; },
            get error() { observations.push("error"); return ++errorReads === 1 ? undefined : true; },
        });
        expect(() => f.app().run("target")).toThrow(message(stage));
        expect(observations).toEqual([...(stage === "probe" ? ["status"] : []), "error", "status", "status", "error"]);
    });
    it("retains probe's final accepted-status conjunction", () => {
        let reads = 0;
        const values = [1, 2, 2, 0];
        const f = fixture("probe", { get status() { return values[reads++]!; } });
        expect(f.app().run("target")).toBeUndefined();
        expect(reads).toBe(4);
        expect(f.trace).toEqual(stages.map(s => `${s}:target`));
    });
    it.each(stages)("observes code once without coercing it for %s", stage => {
        let reads = 0;
        const code = { toString() { throw new Error("unreachable coercion"); } };
        const f = fixture(stage, { status: stage === "probe" ? 1 : 0, error: { get code() { reads++; return reads === 1 ? code : "ETIMEDOUT"; } } });
        expect(() => f.app().run("target")).toThrow(message(stage));
        expect(reads).toBe(1);
    });
});

describe("Codex config preparation exception identity", () => {
    it.each(stages)("preserves %s dispatch and every observed getter exception", stage => {
        const observations = stage === "probe"
            ? ["dispatch", "status:1", "error:1", "code", "status:2", "status:3", "error:2", "status:4", "status:5"]
            : ["dispatch", "error:1", "code", "status:1", "status:2", "error:2", "status:3"];
        for (const step of observations) for (const failure of [new Error(step), { step }]) {
            const trace: string[] = []; let statusReads = 0; let errorReads = 0;
            const visit = (name: string) => { trace.push(name); if (name === step) throw failure; };
            const f = fixture();
            f.ports[stage] = () => { visit("dispatch"); return {
                get status() { visit(`status:${++statusReads}`); return stage === "probe" ? 1 : 0; },
                get error() { visit(`error:${++errorReads}`); return errorReads === 1 ? { get code() { visit("code"); return undefined; } } : undefined; },
            }; };
            expect(thrown(() => f.app().run("target"))).toBe(failure);
            expect(trace).toEqual(observations.slice(0, observations.indexOf(step) + 1));
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage)).map(s => `${s}:target`));
        }
    });
    it.each(stages)("preserves live %s capability getter exceptions after construction", stage => {
        for (const failure of [new Error(stage), { stage }]) {
            const f = fixture(); const app = f.app();
            Object.defineProperty(f.ports, stage, { get() { throw failure; } });
            expect(thrown(() => app.run("target"))).toBe(failure);
            expect(f.trace).toEqual(stages.slice(0, stages.indexOf(stage)).map(s => `${s}:target`));
        }
    });
});
