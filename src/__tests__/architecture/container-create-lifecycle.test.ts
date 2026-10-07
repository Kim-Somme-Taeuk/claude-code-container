import { describe, expect, it } from "vitest";
import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type {
    ContainerCreateLifecyclePorts,
    CreatedContainerMountVerification,
} from "../../ports/container-create-lifecycle.js";

const id = "a".repeat(64);
const request = { containerName: "name", projectMountIdentity: "physical" };
// These expected sequences follow the original fresh-create callback in Docker.
const pre = ["lock:mount-physical", "namespace:name", "collision", "creating:name:undefined", "lab", "args", "project", "device", "filesystem", "create", "status", "stdout"];
const post = ["project", "device", "filesystem"];
const handoff = [`verify:${id}`, `mcp:${id}`, `ssh:${id}`, `git:${id}`, `finish:${id}`];
const missingIdMessage = "created container bind mount identity verification failed (container runtime did not return an exact 64-hex container ID)";

function fixture() {
    const trace: string[] = [];
    const args = ["run", "--detach"];
    const state = {
        namespace: false,
        collision: null as { containerName: string } | null,
        status: 0 as number | null,
        stdout: id as string | null | undefined,
        verification: { kind: "verified", via: "identity" } as CreatedContainerMountVerification,
        absent: true,
        locked: false,
    };
    const effect = (name: string): undefined => { trace.push(name); return undefined; };
    const ports: ContainerCreateLifecyclePorts = {
        withFamilyLock: (prefix, operation) => {
            trace.push(`lock:${prefix}`);
            state.locked = true;
            try { return operation(); } finally { state.locked = false; }
        },
        namespaceExists: name => { trace.push(`namespace:${name}`); return state.namespace; },
        findCollision: () => { trace.push("collision"); return state.collision; },
        reportCreating: (name, debug) => effect(`creating:${name}:${debug}`),
        reportLabWarning: () => effect("lab"),
        reportCreateFailure: () => effect("failure"),
        prepareRunArgs: () => { trace.push("args"); return args; },
        assertProjectSources: () => effect("project"),
        assertDeviceSources: () => effect("device"),
        assertFilesystemSources: () => effect("filesystem"),
        create: supplied => {
            expect(supplied).toBe(args);
            trace.push("create");
            return {
                get status() { trace.push("status"); return state.status; },
                get stdout() { trace.push("stdout"); return state.stdout; },
            };
        },
        verifyCreated: target => { trace.push(`verify:${target}`); return state.verification; },
        removeRejected: target => effect(`remove:${target}`),
        explicitlyAbsent: target => { trace.push(`absent:${target}`); return state.absent; },
        syncMcp: target => effect(`mcp:${target}`),
        fixSsh: target => effect(`ssh:${target}`),
        syncGit: target => effect(`git:${target}`),
        finish: target => { trace.push(`finish:${target}`); return "public-name"; },
    };
    return { trace, state, ports, app: createContainerCreateLifecycle(ports) };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

describe("create lifecycle required capabilities", () => {
    it("constructs without effects and rejects every missing or noncallable port", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        for (const name of Object.keys(f.ports)) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                const error = thrown(() => createContainerCreateLifecycle({ ...f.ports, [name]: invalid } as unknown as ContainerCreateLifecyclePorts));
                expect(error).toBeInstanceOf(TypeError);
                expect((error as Error).message).toBe(`Container create lifecycle requires a callable ${name} port.`);
            }
        }
        expect(() => createContainerCreateLifecycle(undefined as unknown as ContainerCreateLifecyclePorts)).toThrow(TypeError);
        expect(f.trace).toEqual([]);
    });

    it("keeps every effect in the lock and returns the finish value", () => {
        const f = fixture();
        for (const name of Object.keys(f.ports) as Array<keyof ContainerCreateLifecyclePorts>) {
            if (name === "withFamilyLock") continue;
            const original = f.ports[name];
            Object.assign(f.ports, { [name]: function (this: ContainerCreateLifecyclePorts, ...args: unknown[]) {
                expect(f.state.locked).toBe(true);
                expect(this).toBe(f.ports);
                return Reflect.apply(original, this, args);
            } });
        }
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
        expect(f.state.locked).toBe(false);
    });

    it("uses current capabilities including mutations inside the callback", () => {
        const f = fixture();
        f.ports.reportCreating = function (name, debug) {
            expect(this).toBe(f.ports);
            f.trace.push(`creating:${name}:${debug}`);
            this.prepareRunArgs = function () {
                expect(this).toBe(f.ports);
                f.trace.push("replacement-args");
                return ["changed"];
            };
            this.create = function (args) {
                expect(this).toBe(f.ports);
                expect(args).toEqual(["changed"]);
                f.trace.push("replacement-create");
                return { status: 0, stdout: id };
            };
            return undefined;
        };
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre.slice(0, 5), "replacement-args", ...post, "replacement-create", ...post, ...handoff]);
    });

    it("preserves lock return without callback invocation", () => {
        const f = fixture();
        f.ports.withFamilyLock = function (prefix) { expect(this).toBe(f.ports); f.trace.push(prefix); return "lock-result"; };
        expect(f.app.run(request)).toBe("lock-result");
        expect(f.trace).toEqual(["mount-physical"]);
    });

    it("repeats the entire callback if the supplied lock repeats it", () => {
        const f = fixture();
        f.ports.withFamilyLock = (_prefix, operation) => { operation(); operation(); return "after-two"; };
        expect(f.app.run(request)).toBe("after-two");
        const callback = [...pre.slice(1), ...post, ...handoff];
        expect(f.trace).toEqual([...callback, ...callback]);
    });

    it.each([false, true])("propagates lock failure after callback=%s", invoke => {
        const f = fixture(); const failure = { lock: true };
        f.ports.withFamilyLock = (_prefix, operation) => { if (invoke) operation(); throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual(invoke ? [...pre.slice(1), ...post, ...handoff] : []);
    });
});

describe("create lifecycle preflight and dispatch", () => {
    it("refuses potentially occupied namespace before collision or reports", () => {
        const f = fixture(); f.state.namespace = true;
        expect(() => f.app.run(request)).toThrow("Container namespace name appeared during creation preflight; refusing replacement.");
        expect(f.trace).toEqual(pre.slice(0, 2));
    });

    it.each([undefined, "", "lab-runner"])("preserves collision profile %s", profile => {
        const f = fixture(); f.state.collision = { containerName: "owner" };
        expect(() => f.app.run({ ...request, profile })).toThrow(
            `CCC container owner already owns this physical project for profile ${profile ?? "default"}; refusing duplicate container creation. The existing container was preserved.`,
        );
        expect(f.trace).toEqual(pre.slice(0, 3));
    });

    it.each([undefined, false, true])("passes debug %s before lazy warning and args", debug => {
        const f = fixture();
        f.app.run({ ...request, debug });
        expect(f.trace).toEqual([...pre.slice(0, 3), `creating:name:${debug}`, ...pre.slice(4), ...post, ...handoff]);
    });

    it.each([
        ["namespaceExists", 1], ["findCollision", 2], ["reportCreating", 3],
        ["reportLabWarning", 4], ["prepareRunArgs", 5], ["assertProjectSources", 6],
        ["assertDeviceSources", 7], ["assertFilesystemSources", 8], ["create", 9],
    ] as const)("propagates %s failure without dispatch or compensation", (name, completed) => {
        const f = fixture(); const failure = { port: name };
        Object.assign(f.ports, { [name]: () => { throw failure; } });
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual(pre.slice(0, completed));
    });

    it.each([null, 1, -1])("checks status %s before stdout and refuses without compensation", status => {
        const f = fixture(); f.state.status = status;
        expect(() => f.app.run(request)).toThrow("Failed to create container");
        expect(f.trace).toEqual([...pre.slice(0, -1), "failure"]);
    });

    it("propagates a failed-status reporter throw", () => {
        const f = fixture(); f.state.status = 1; const failure = { report: true };
        f.ports.reportCreateFailure = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual(pre.slice(0, -1));
    });

    it("accepts status zero despite a native error field and never observes that field", () => {
        const f = fixture();
        f.ports.create = () => {
            f.trace.push("create");
            return { status: 0, stdout: id, get error() { throw new Error("error field observed"); } };
        };
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre.slice(0, 10), ...post, ...handoff]);
    });

    it.each(["status", "stdout"] as const)("propagates %s getter throws outside compensation", property => {
        const f = fixture(); const failure = { property };
        f.ports.create = () => {
            f.trace.push("create");
            return {
                get status() { f.trace.push("status"); if (property === "status") throw failure; return 0; },
                get stdout(): never { f.trace.push("stdout"); throw failure; },
            };
        };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual(pre.slice(0, property === "status" ? 11 : 12));
    });
});

describe("create lifecycle exact ID and proof", () => {
    it.each([
        ` \n${id}\t`,
        `pull message 123456789abc x${id} ${id}x ${id} ${"b".repeat(64)}`,
        `noise ${id.toUpperCase()} ${id}`,
    ])("selects first complete token and preserves case from %s", stdout => {
        const f = fixture(); f.state.stdout = stdout;
        const expected = stdout.includes(id.toUpperCase()) ? id.toUpperCase() : id;
        f.app.run(request);
        expect(f.trace).toEqual([...pre, ...post, ...handoff.map(event => event.replace(id, expected))]);
    });

    it.each([undefined, null, "", " \t\n", "123456789abc", `x${id}`, `${id}x`, "g".repeat(64)])("rejects unpinned output %s after all source checks", stdout => {
        const f = fixture(); f.state.stdout = stdout;
        const error = thrown(() => f.app.run(request));
        expect((error as Error).message).toBe(missingIdMessage);
        expect(f.trace).toEqual([...pre, ...post]);
    });

    it.each(["shape", "source", "identity", "daemon"] as const)("accepts verified via %s", via => {
        const f = fixture(); f.state.verification = { kind: "verified", via };
        expect(f.app.run(request)).toBe("public-name");
        expect(f.trace).toEqual([...pre, ...post, ...handoff]);
    });

    it.each([
        { kind: "deferred", reason: "deferred", containerPath: "/project" },
        { kind: "retryable", reason: "retryable" },
        { kind: "mismatch", reason: "mismatch", containerPath: "/project" },
    ] satisfies CreatedContainerMountVerification[])("rejects $kind without an application retry and proves removal", verification => {
        const f = fixture(); f.state.verification = verification;
        expect(() => f.app.run(request)).toThrow(`created container bind mount identity verification failed (${verification.reason})`);
        expect(f.trace).toEqual([...pre, ...post, `verify:${id}`, `remove:${id}`, `absent:${id}`]);
    });

    it.each([
        ["assertProjectSources", 0], ["assertDeviceSources", 1], ["assertFilesystemSources", 2],
    ] as const)("compensates a post-create %s failure using the exact ID", (name, preceding) => {
        const f = fixture(); const failure = new Error("source swapped"); let checks = 0;
        const original = f.ports[name];
        f.ports[name] = () => { if (++checks === 2) throw failure; return original(); };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual([...pre, ...post.slice(0, preceding), `remove:${id}`, `absent:${id}`]);
    });

    it.each([
        ["assertProjectSources", 0], ["assertDeviceSources", 1], ["assertFilesystemSources", 2],
    ] as const)("preserves post-source %s failure ahead of missing ID without cleanup", (name, preceding) => {
        const f = fixture(); f.state.stdout = "short"; const failure = { source: name }; let checks = 0;
        const original = f.ports[name];
        f.ports[name] = () => { if (++checks === 2) throw failure; return original(); };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual([...pre, ...post.slice(0, preceding)]);
    });
});

describe("create lifecycle compensation and late failures", () => {
    it.each([new Error("original"), { marker: "non-Error" }, "literal", undefined])("rethrows original value %s after explicit absence", original => {
        const f = fixture();
        f.ports.verifyCreated = target => { f.trace.push(`verify:${target}`); throw original; };
        expect(thrown(() => f.app.run(request))).toBe(original);
        expect(f.trace).toEqual([...pre, ...post, `verify:${id}`, `remove:${id}`, `absent:${id}`]);
    });

    it.each([new Error("original"), { marker: "non-Error" }, "literal"])("retains primary cause and legacy message access for unproved absence %s", original => {
        const f = fixture(); f.state.absent = false;
        f.ports.verifyCreated = () => { throw original; };
        const error = thrown(() => f.app.run(request)) as Error;
        expect(error.message).toBe(`${(original as Error).message}; failed to remove rejected container ${id}`);
        expect(error.cause).toBe(original);
        expect(f.trace).toEqual([...pre, ...post, `remove:${id}`, `absent:${id}`]);
    });

    it.each([null, undefined])("preserves legacy message access throw for unproved absence of %s", original => {
        const f = fixture(); f.state.absent = false;
        f.ports.verifyCreated = () => { throw original; };
        expect(thrown(() => f.app.run(request))).toBeInstanceOf(TypeError);
        expect(f.trace).toEqual([...pre, ...post, `remove:${id}`, `absent:${id}`]);
    });

    it("ignores a removal return value and still asks for explicit absence", () => {
        const f = fixture(); f.state.verification = { kind: "mismatch", reason: "bad" };
        f.ports.removeRejected = ((target: string) => {
            f.trace.push(`remove:${target}`);
            return { status: 1, error: new Error("rm failed") };
        }) as unknown as ContainerCreateLifecyclePorts["removeRejected"];
        expect(() => f.app.run(request)).toThrow("created container bind mount identity verification failed (bad)");
        expect(f.trace).toEqual([...pre, ...post, `verify:${id}`, `remove:${id}`, `absent:${id}`]);
    });

    it.each(["removeRejected", "explicitlyAbsent"] as const)("propagates %s native throw without wrapping", name => {
        const f = fixture(); f.state.verification = { kind: "mismatch", reason: "bad" }; const failure = { native: name };
        f.ports[name] = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual([...pre, ...post, `verify:${id}`, ...(name === "explicitlyAbsent" ? [`remove:${id}`] : [])]);
    });

    it.each([["syncMcp", 1], ["fixSsh", 2], ["syncGit", 3], ["finish", 4]] as const)("propagates late %s failure without rollback", (name, completed) => {
        const f = fixture(); const failure = { late: name };
        f.ports[name] = () => { throw failure; };
        expect(thrown(() => f.app.run(request))).toBe(failure);
        expect(f.trace).toEqual([...pre, ...post, ...handoff.slice(0, completed)]);
    });
});
