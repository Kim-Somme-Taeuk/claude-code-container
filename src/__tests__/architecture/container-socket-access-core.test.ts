import { describe, expect, it } from "vitest";
import { createContainerSocketAccess } from "../../application/container-socket-access.js";
import type { ContainerSocketAccessPorts } from "../../ports/container-socket-access.js";

const capabilities = ["probe", "grant", "warn"] as const;
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
function fixture(status: number | null = 10, stdout: unknown = "ccc\n0\n", grantStatus: number | null = 0) {
    const trace: unknown[] = [];
    const ports: ContainerSocketAccessPorts = {
        probe(target) { expect(this).toBe(ports); trace.push(["probe", target]); return { status, stdout }; },
        grant(target, user, gid) { expect(this).toBe(ports); trace.push(["grant", target, user, gid]); return { status: grantStatus }; },
        warn() { expect(this).toBe(ports); trace.push("warn"); return undefined; },
    };
    return { trace, ports };
}

describe("container socket access construction", () => {
    it("checks required capabilities in order without invoking them", () => {
        const f = fixture();
        const observed = {} as ContainerSocketAccessPorts;
        for (const name of capabilities) Object.defineProperty(observed, name, {
            get() { f.trace.push(name); return f.ports[name]; },
        });
        createContainerSocketAccess(observed);
        expect(f.trace).toEqual(capabilities);
    });
    it.each(capabilities)("rejects noncallable %s before later observations", name => {
        for (const invalid of [undefined, null, false, 1, "function", {}]) {
            const f = fixture();
            const observed = {} as ContainerSocketAccessPorts;
            for (const capability of capabilities) Object.defineProperty(observed, capability, {
                get() { f.trace.push(capability); return capability === name ? invalid : f.ports[capability]; },
            });
            const error = thrown(() => createContainerSocketAccess(observed));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toBe(`Container socket access requires a callable ${name} port.`);
            expect(f.trace).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
        }
    });
    it("rejects absent ports with the first diagnostic", () => {
        for (const invalid of [undefined, null, {}]) expect(() => createContainerSocketAccess(invalid as ContainerSocketAccessPorts))
            .toThrow("Container socket access requires a callable probe port.");
    });
    it.each(capabilities)("preserves %s getter exceptions", name => {
        for (const failure of [new Error("getter"), { name }]) {
            const f = fixture();
            const observed = {} as ContainerSocketAccessPorts;
            for (const capability of capabilities) Object.defineProperty(observed, capability, {
                get() { f.trace.push(capability); if (capability === name) throw failure; return f.ports[capability]; },
            });
            expect(thrown(() => createContainerSocketAccess(observed))).toBe(failure);
            expect(f.trace).toEqual(capabilities.slice(0, capabilities.indexOf(name) + 1));
        }
    });
});

describe("container socket access observations and validation", () => {
    it("returns immediately on status zero without observing stdout", () => {
        const f = fixture();
        f.ports.probe = target => { f.trace.push(["probe", target]); return {
            get status() { f.trace.push("status"); return 0; },
            get stdout(): unknown { throw new Error("unreachable stdout"); },
        }; };
        expect(createContainerSocketAccess(f.ports).run("exact-target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "exact-target"], "status"]);
    });
    it.each([10, 1, null])("reads status, stdout/coercion, then status for %s", status => {
        const f = fixture();
        f.ports.probe = () => ({
            get status() { f.trace.push("status"); return status; },
            get stdout() { f.trace.push("stdout"); return { toString() { f.trace.push("coerce"); return " \tccc\n00042 extra tokens\n"; } }; },
        });
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
        expect(f.trace).toEqual(["status", "stdout", "coerce", "status", status === 10 ? ["grant", "target", "ccc", "00042"] : "warn"]);
    });
    it("uses the second status observation rather than a cached status", () => {
        const f = fixture();
        let reads = 0;
        f.ports.probe = () => ({ get status() { return ++reads === 1 ? 1 : 10; }, stdout: "ccc 0" });
        createContainerSocketAccess(f.ports).run("target");
        expect(reads).toBe(2);
        expect(f.trace).toEqual([["grant", "target", "ccc", "0"]]);
    });
    it.each(["a 0", "_ 1", "a_b-9 000", `${"a".repeat(32)} 1234567890`, "ubuntu 1000", "ccc 0 ignored"])("grants exact valid tokens: %s", stdout => {
        const f = fixture(10, stdout);
        createContainerSocketAccess(f.ports).run("target");
        const [user, gid] = stdout.split(/\s+/);
        expect(f.trace).toEqual([["probe", "target"], ["grant", "target", user, gid]]);
    });
    it.each([undefined, null, "", " \t\n", "ccc", "0ccc 0", "CCC 0", "bad;user 0", "ccc$(id) 0", `${"a".repeat(33)} 0`, "ccc -1", "ccc 0x1", "ccc 1;id", "ccc 12345678901", 123, Symbol("x"), { toString: () => "ccc nope" }])("rejects malformed output without grant: %s", stdout => {
        const f = fixture();
        f.ports.probe = target => { f.trace.push(["probe", target]); return { status: 10, stdout }; };
        createContainerSocketAccess(f.ports).run("target");
        expect(f.trace).toEqual([["probe", "target"], "warn"]);
    });
    it.each([1, -1, null, 124, 137])("warns for returned probe status %s without inspecting error", status => {
        const f = fixture();
        f.ports.probe = () => ({ status, stdout: "ccc 0", get error(): unknown { throw new Error("unreachable error"); } });
        createContainerSocketAccess(f.ports).run("target");
        expect(f.trace).toEqual(["warn"]);
    });
    it.each([0, 1, null, 124, 137])("classifies only grant status %s", status => {
        const f = fixture();
        f.ports.grant = () => ({ status, get error(): unknown { throw new Error("unreachable error"); } });
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
        expect(f.trace).toEqual([["probe", "target"], ...(status === 0 ? [] : ["warn"])]);
    });
    it("resolves all capabilities live with their ports receiver", () => {
        const f = fixture();
        const app = createContainerSocketAccess(f.ports);
        f.ports.probe = function (target) { expect(this).toBe(f.ports); f.trace.push(["new-probe", target]);
            f.ports.grant = function (...args) { expect(this).toBe(f.ports); f.trace.push(["new-grant", ...args]);
                f.ports.warn = function () { expect(this).toBe(f.ports); f.trace.push("new-warn"); return undefined; };
                return { status: 1 }; };
            return { status: 10, stdout: "ccc 0" }; };
        app.run("target");
        expect(f.trace).toEqual([["new-probe", "target"], ["new-grant", "target", "ccc", "0"], "new-warn"]);
    });
});

describe("container socket access exception identity", () => {
    const steps = ["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status", "warn"];
    it.each(steps)("preserves Error/non-Error at %s and stops later effects", step => {
        for (const failure of [new Error(step), { step }]) {
            const trace: string[] = [];
            const visit = (name: string) => { trace.push(name); if (name === step) throw failure; };
            let reads = 0;
            const app = createContainerSocketAccess({
                probe() { visit("probe"); return {
                    get status() { visit(`status:${++reads}`); return 10; },
                    get stdout() { visit("stdout"); return { toString() { visit("coerce"); return "ccc 0"; } }; },
                }; },
                grant() { visit("grant"); return { get status() { visit("grant-status"); return 1; } }; },
                warn() { visit("warn"); return undefined; },
            });
            expect(thrown(() => app.run("target"))).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
        }
    });
});

describe("container socket warning lifetime", () => {
    it("warns once across targets while continuing native observations, and reset only forgets state", () => {
        const f = fixture(10, "ccc 0", 1);
        const app = createContainerSocketAccess(f.ports);
        app.run("one"); app.run("two");
        expect(f.trace).toEqual([["probe", "one"], ["grant", "one", "ccc", "0"], "warn", ["probe", "two"], ["grant", "two", "ccc", "0"]]);
        const beforeReset = [...f.trace];
        expect(app.resetWarning()).toBeUndefined();
        expect(f.trace).toEqual(beforeReset);
        app.run("three");
        expect(f.trace.at(-1)).toBe("warn");
    });
    it("keeps separate application state even when ports are shared", () => {
        const f = fixture(1);
        const one = createContainerSocketAccess(f.ports), two = createContainerSocketAccess(f.ports);
        one.run("one"); one.run("one"); two.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
    it("advances state before warning, including reentrant failures and thrown warnings", () => {
        for (const failure of [new Error("warn"), { failure: "warn" }]) {
            const f = fixture(1);
            const app = createContainerSocketAccess(f.ports);
            f.ports.warn = () => { f.trace.push("warn"); app.run("reentrant"); throw failure; };
            expect(thrown(() => app.run("outer"))).toBe(failure);
            expect(app.run("later")).toBeUndefined();
            expect(f.trace).toEqual([["probe", "outer"], "warn", ["probe", "reentrant"], ["probe", "later"]]);
            app.resetWarning();
            expect(thrown(() => app.run("reset"))).toBe(failure);
        }
    });
    it("lets a warning reset state for the next invocation", () => {
        const f = fixture(1);
        const app = createContainerSocketAccess(f.ports);
        f.ports.warn = () => { f.trace.push("warn"); app.resetWarning(); return undefined; };
        app.run("one"); app.run("two");
        expect(f.trace.filter(entry => entry === "warn")).toHaveLength(2);
    });
    it.each(["Promise", "thenable"])("ignores hostile %s warning returns", kind => {
        const f = fixture(1);
        const ignored = kind === "Promise" ? Promise.resolve("ignored") : {};
        Object.defineProperty(ignored, "then", { get() { throw new Error("must not inspect returned effect"); } });
        f.ports.warn = (() => ignored) as unknown as ContainerSocketAccessPorts["warn"];
        expect(createContainerSocketAccess(f.ports).run("target")).toBeUndefined();
    });
});
