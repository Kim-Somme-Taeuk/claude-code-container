import { describe, expect, it } from "vitest";
import { createSessionClaims } from "../../application/session-claims.js";
import {
    encodeSessionClaim, sessionClaimName, sessionClaimPrefix,
    sessionLockClaimsForContainer, sessionLockClaimsForProjectFamily,
} from "../../domain/session-claims.js";
import type { ProcessStartObservation, SessionLockLiveness } from "../../domain/session-lock.js";
import type { SessionClaimsPorts } from "../../ports/session-claims.js";

const current = "project--current.lock";
const old = "project--old.lock";
const other = "project--other.lock";
const versioned = (pid = 42, token = "opaque") => JSON.stringify({ version: 2, pid, startToken: token });

function fixture(entries: string[] = [], contents: Record<string, string> = {}) {
    const trace: string[] = [];
    const records = { ...contents };
    const writes: Array<[string, string]> = [];
    const removals: string[] = [];
    const batches: Array<readonly number[]> = [];
    const classifications: Array<[string, ReadonlyMap<number, ProcessStartObservation>]> = [];
    const observations = new Map<number, ProcessStartObservation>();
    let held = false;
    const ports: SessionClaimsPorts = {
        ensureDirectory() { trace.push("ensure"); return undefined; },
        listEntries() { trace.push("list"); return entries; },
        claimPath(name) { trace.push(`path:${name}`); return `/claims/${name}`; },
        claimName(path) { trace.push(`name:${path}`); return path.slice(path.lastIndexOf("/") + 1); },
        readClaim(name) { trace.push(`read:${name}`); if (!(name in records)) throw new Error("unreadable"); return records[name]; },
        writeClaim(path, content) { trace.push(`write:${path}`); writes.push([path, content]); return undefined; },
        removeClaim(path) { trace.push(`remove:${path}`); removals.push(path); return undefined; },
        createId() { trace.push("id"); return "abcdef"; },
        currentPid() { trace.push("pid"); return 42; },
        startToken(pid) { trace.push(`token:${pid}`); return "opaque"; },
        observeOwners(pids) { trace.push("observe"); batches.push([...pids]); return observations; },
        classify(content, observed) { trace.push(`classify:${content}`); classifications.push([content, observed]); return "active"; },
        withLifecycleLock<T>(prefix: string, operation: () => T): T {
            trace.push(`lock:${prefix}`);
            held = true;
            try { return operation(); } finally { held = false; trace.push(`unlock:${prefix}`); }
        },
    };
    return { ports, trace, records, writes, removals, batches, observations, classifications, isHeld: () => held };
}

const portNames = ["ensureDirectory", "listEntries", "claimPath", "claimName", "readClaim", "writeClaim", "removeClaim",
    "createId", "currentPid", "startToken", "observeOwners", "classify", "withLifecycleLock"] as const;

describe("session claim domain compatibility", () => {
    it("preserves prefix and exact record bytes, including legacy fallback without a newline", () => {
        expect(sessionClaimPrefix("project")).toBe("project");
        expect(sessionClaimPrefix("project", "")).toBe("project");
        expect(sessionClaimPrefix("project", "work--extra")).toBe("project--p--work--extra");
        expect(sessionClaimName("project--p--work", "abcdef")).toBe("project--p--work--abcdef.lock");
        expect(encodeSessionClaim(42, "opaque")).toBe('{"version":2,"pid":42,"startToken":"opaque"}');
        expect(encodeSessionClaim(42, null)).toBe("42");
        expect(encodeSessionClaim(42, "")).toBe("42");
    });

    const names = ["other--a.lock", "project--b.lock", "project-a.lock", "project--p--work--c.lock",
        "project--p--work--extra--d.lock", "project--p--work--.lock", "project--.lock", "project-.lock",
        "project--b.lock.tmp", "project.container-lifecycle.guard", "project--p--work-a.lock", "project--p--work--e.lock"];
    it("preserves nonprofile legacy selection, permissive empty segments, and enumeration order", () => {
        expect(sessionLockClaimsForContainer(names, "project")).toEqual([
            "project--b.lock", "project-a.lock", "project--.lock", "project-.lock",
        ]);
        expect(names).toHaveLength(12);
    });
    it("selects exactly one nonempty session segment after a profile prefix", () => {
        expect(sessionLockClaimsForContainer(names, "project--p--work")).toEqual([
            "project--p--work--c.lock", "project--p--work--e.lock",
        ]);
        expect(sessionLockClaimsForContainer(names, "project--p--work--extra")).toEqual(["project--p--work--extra--d.lock"]);
    });
    it("family queries retain double-dash claims only, including profiles and empty segments", () => {
        expect(sessionLockClaimsForProjectFamily(names, "project")).toEqual([
            "project--b.lock", "project--p--work--c.lock", "project--p--work--extra--d.lock",
            "project--p--work--.lock", "project--.lock", "project--p--work-a.lock", "project--p--work--e.lock",
        ]);
    });
});

describe("explicit session claims construction", () => {
    it.each([null, undefined])("rejects absent ports %s", ports => {
        expect(() => createSessionClaims(ports as unknown as SessionClaimsPorts)).toThrow(TypeError);
    });
    for (const name of portNames) {
        it(`requires callable ${name} without invoking any other port`, () => {
            for (const invalid of [undefined, null, false, 0, "callback", {}]) {
                const f = fixture();
                expect(() => createSessionClaims({ ...f.ports, [name]: invalid } as unknown as SessionClaimsPorts)).toThrow(TypeError);
                expect(f.trace).toEqual([]);
            }
            const f = fixture();
            const incomplete: Record<string, unknown> = { ...f.ports };
            delete incomplete[name];
            expect(() => createSessionClaims(incomplete as unknown as SessionClaimsPorts)).toThrow(TypeError);
            expect(f.trace).toEqual([]);
        });
    }
    it("constructs without effects and observes replacement callbacks lazily", () => {
        const f = fixture();
        const app = createSessionClaims(f.ports);
        expect(f.trace).toEqual([]);
        f.ports.listEntries = () => [other];
        expect(app.getSessionLockClaimsForContainer("project")).toEqual([other]);
        expect(f.trace).toEqual(["ensure"]);
    });
});

describe("session reservation", () => {
    it.each([undefined, "work"])("reserves in an already-held guard without sweeping or reacquiring profile %j", profile => {
        const f = fixture([old], { [old]: "7" });
        const prefix = profile ? "project--p--work" : "project";
        const path = `/claims/${prefix}--abcdef.lock`;
        const lock = f.ports.withLifecycleLock;
        f.ports.withLifecycleLock = (name, operation) => {
            expect(f.isHeld()).toBe(false);
            return lock(name, operation);
        };
        f.ports.classify = () => { throw new Error("predecessor must not be reconciled before transfer"); };
        f.ports.withLifecycleLock(prefix, () => {
            const write = f.ports.writeClaim;
            f.ports.writeClaim = (destination, content) => { expect(f.isHeld()).toBe(true); return write(destination, content); };
            expect(createSessionClaims(f.ports).reserveSessionLockInHeldLifecycleLock("project", profile)).toBe(path);
        });
        expect(f.writes).toEqual([[path, versioned()]]);
        expect(f.removals).toEqual([]);
        expect(f.trace).toEqual([`lock:${prefix}`, "ensure", "id", `path:${prefix}--abcdef.lock`, "pid", "token:42", "pid", `write:${path}`, `unlock:${prefix}`]);
        expect(f.batches).toEqual([]);
    });
    it.each([undefined, "", "work--extra"])("captures ID and destination before locking profile %j", profile => {
        const f = fixture();
        const prefix = profile ? `project--p--${profile}` : "project";
        const path = `/claims/${prefix}--abcdef.lock`;
        expect(createSessionClaims(f.ports).createSessionLock("project", profile)).toBe(path);
        expect(f.writes).toEqual([[path, versioned()]]);
        expect(f.trace).toEqual(["ensure", "id", `path:${prefix}--abcdef.lock`, `lock:${prefix}`, "ensure", "list", "observe", "pid", "token:42", "pid", `write:${path}`, `unlock:${prefix}`]);
    });
    it("captures the path before lock callback changes its environment and observes PID after token lookup", () => {
        const f = fixture();
        let pid = 42;
        f.ports.currentPid = () => pid;
        f.ports.startToken = owner => { expect(owner).toBe(42); pid = 43; f.ports.claimPath = name => `/changed/${name}`; return null; };
        expect(createSessionClaims(f.ports).createSessionLock("project")).toBe("/claims/project--abcdef.lock");
        expect(f.writes).toEqual([["/claims/project--abcdef.lock", "43"]]);
    });
    it("removes proven stale claims inside the lifecycle guard before reserving the new claim", () => {
        const entries = [old, other];
        const f = fixture(entries, { [old]: versioned(7), [other]: versioned(8) });
        f.ports.classify = content => { expect(f.isHeld()).toBe(true); return content === versioned(7) ? "stale" : "active"; };
        f.ports.removeClaim = path => {
            expect(f.isHeld()).toBe(true);
            expect(f.writes).toEqual([]);
            f.removals.push(path);
            entries.splice(entries.indexOf(path.slice(path.lastIndexOf("/") + 1)), 1);
        };
        const write = f.ports.writeClaim;
        f.ports.writeClaim = (path, content) => {
            expect(f.isHeld()).toBe(true);
            expect(entries).toEqual([other]);
            return write(path, content);
        };
        expect(createSessionClaims(f.ports).createSessionLock("project")).toBe("/claims/project--abcdef.lock");
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.writes).toEqual([["/claims/project--abcdef.lock", versioned()]]);
    });
    it("retains active, unknown and unreadable owners while reserving", () => {
        const unreadable = "project--unreadable.lock";
        const f = fixture([old, other, unreadable], { [old]: "7", [other]: "8" });
        f.ports.classify = content => content === "7" ? "active" : "unknown";
        createSessionClaims(f.ports).createSessionLock("project");
        expect(f.batches).toEqual([[7, 8]]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${old}`, `read:${other}`, `read:${unreadable}`]);
        expect(f.removals).toEqual([]);
        expect(f.writes).toHaveLength(1);
    });
    it.each([undefined, "work"])("sweeps only the exact reservation prefix for profile %j", profile => {
        const profiled = "project--p--work--a.lock";
        const sibling = "project--p--work--extra--b.lock";
        const unrelated = "other--a.lock";
        const f = fixture([old, profiled, sibling, unrelated], {
            [old]: "7", [profiled]: "8", [sibling]: "9", [unrelated]: "10",
        });
        f.ports.classify = () => "stale";
        createSessionClaims(f.ports).createSessionLock("project", profile);
        const selected = profile ? profiled : old;
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${selected}`]);
        expect(f.removals).toEqual([`/claims/${selected}`]);
        expect(f.batches).toEqual([[profile ? 8 : 7]]);
    });
    it.each(["ensureDirectory", "createId", "claimPath", "withLifecycleLock", "startToken", "writeClaim"] as const)("propagates reservation %s failure and stops", member => {
        const f = fixture();
        const failure = { member, code: member === "writeClaim" ? "EEXIST" : "EACCES" };
        Object.assign(f.ports, { [member]: () => { f.trace.push(`fail:${member}`); throw failure; } });
        let caught: unknown;
        try { createSessionClaims(f.ports).createSessionLock("project"); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.writes).toEqual([]);
        expect(f.removals).toEqual([]);
        expect(f.trace.at(-1)).toBe(["startToken", "writeClaim"].includes(member) ? "unlock:project" : `fail:${member}`);
        if (["ensureDirectory", "createId", "claimPath", "withLifecycleLock"].includes(member)) expect(f.trace).not.toContain("pid");
    });
});

describe("reconciled foreign claims retain a fresh raw veto", () => {
    it("reconciles under an already-held guard without reacquiring it or pruning the own receipt", () => {
        const entries = [current, old];
        const f = fixture(entries, { [current]: versioned(), [old]: "7" });
        const lock = f.ports.withLifecycleLock;
        f.ports.withLifecycleLock = (prefix, operation) => { expect(f.isHeld()).toBe(false); return lock(prefix, operation); };
        f.ports.classify = () => { expect(f.isHeld()).toBe(true); return "stale"; };
        f.ports.removeClaim = path => { expect(f.isHeld()).toBe(true); f.removals.push(path); entries.splice(entries.indexOf(old), 1); };
        expect(f.ports.withLifecycleLock("project", () => createSessionClaims(f.ports)
            .reconcileForeignClaimsInHeldLifecycleLock("project", `/claims/${current}`))).toBe(false);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${old}`]);
        expect(f.trace.filter(value => value.startsWith("lock:"))).toEqual(["lock:project"]);
        expect(entries).toEqual([current]);
    });
    it("leaves a proven stale own receipt untouched while removing only foreign stale claims", () => {
        const entries = [current, old];
        const f = fixture(entries, { [current]: versioned(42), [old]: versioned(7) });
        f.observations.set(42, { status: "missing" });
        f.observations.set(7, { status: "missing" });
        f.ports.classify = content => { f.classifications.push([content, f.observations]); return "stale"; };
        f.ports.removeClaim = path => {
            f.removals.push(path);
            entries.splice(entries.indexOf(path.slice(path.lastIndexOf("/") + 1)), 1);
        };
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(false);
        expect(entries).toEqual([current]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${old}`]);
        expect(f.batches).toEqual([[7]]);
        expect(f.classifications.map(([content]) => content)).toEqual([versioned(7)]);
        expect(f.removals).toEqual([`/claims/${old}`]);
    });
    it("removes a proven stale foreign claim before deciding no foreign claim remains", () => {
        const entries = [current, old];
        const f = fixture(entries, { [current]: versioned(), [old]: versioned(7) });
        f.ports.classify = content => content === versioned(7) ? "stale" : "active";
        f.ports.removeClaim = path => {
            f.removals.push(path);
            entries.splice(entries.indexOf(old), 1);
        };
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(false);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.trace.filter(value => value === "list")).toHaveLength(2);
    });
    it("a failed stale unlink remains a raw veto even though the active list would omit it", () => {
        const f = fixture([current, old], { [current]: versioned(), [old]: "7" });
        f.ports.classify = content => content === "7" ? "stale" : "active";
        f.ports.removeClaim = path => { f.removals.push(path); throw new Error("sharing violation"); };
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.trace.filter(value => value === "list")).toHaveLength(2);
    });
    it.each(["active", "unknown", "unreadable"])("a foreign %s claim remains a veto", status => {
        const f = fixture([current, old], { [current]: versioned(), ...(status === "unreadable" ? {} : { [old]: "7" }) });
        f.ports.classify = content => content === versioned() ? "active" : status as SessionLockLiveness;
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.removals).toEqual([]);
    });
    it("preserves a live same-PID legacy claim without treating the current path as replacement proof", () => {
        const f = fixture([current, old], { [current]: versioned(), [old]: "42" });
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${old}`]);
        expect(f.classifications.map(([content]) => content)).toEqual(["42"]);
        expect(f.removals).toEqual([]);
    });
    it("freshly enumerates a successor that appeared after the stale claim was removed", () => {
        const successor = "project--successor.lock";
        const entries = [current, old];
        const f = fixture(entries, { [current]: versioned(), [old]: "7" });
        f.ports.classify = content => content === "7" ? "stale" : "active";
        f.ports.removeClaim = path => {
            f.removals.push(path);
            entries.splice(entries.indexOf(old), 1, successor);
        };
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.trace).not.toContain(`read:${successor}`);
        expect(f.trace.filter(value => value === "list")).toHaveLength(2);
    });
    it("keeps sibling profiles outside both reconciliation and the raw veto", () => {
        const profiled = "project--p--work--a.lock";
        const sibling = "project--p--work--extra--b.lock";
        const f = fixture([current, profiled, sibling], { [current]: "7", [profiled]: versioned(), [sibling]: "8" });
        expect(createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project--p--work", `/claims/${profiled}`)).toBe(false);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([]);
        expect(f.batches).toEqual([[]]);
        expect(f.removals).toEqual([]);
    });
    it("propagates a fresh raw enumeration failure rather than authorizing shutdown", () => {
        const f = fixture([current], { [current]: versioned() });
        const failure = new Error("fresh enumeration unavailable");
        let lists = 0;
        f.ports.listEntries = () => { if (++lists === 2) throw failure; return [current]; };
        expect(() => createSessionClaims(f.ports).hasOtherReconciledSessionClaims("project", `/claims/${current}`)).toThrow(failure);
        expect(lists).toBe(2);
    });
});

describe("raw claims remain independent from inferred liveness", () => {
    it("raw container, family and foreign queries never read, observe, classify or remove claims", () => {
        const f = fixture([current, old, "project--p--work--a.lock", "project-a.lock", "other--a.lock"]);
        const app = createSessionClaims(f.ports);
        expect(app.getSessionLockClaimsForContainer("project")).toEqual([current, old, "project-a.lock"]);
        expect(app.getSessionLockClaimsForProjectFamily("project")).toEqual([current, old, "project--p--work--a.lock"]);
        expect(app.hasOtherSessionClaims("project", `/claims/${current}`)).toBe(true);
        expect(f.trace).toEqual(["ensure", "list", "ensure", "list", "ensure", "list", `name:/claims/${current}`]);
        expect(f.batches).toEqual([]);
        expect(f.classifications).toEqual([]);
        expect(f.removals).toEqual([]);
    });
    it("a missing current claim never hides a foreign raw claim", () => {
        const f = fixture([old]);
        expect(createSessionClaims(f.ports).hasOtherSessionClaims("project", `/claims/${current}`)).toBe(true);
        f.ports.listEntries = () => [current];
        expect(createSessionClaims(f.ports).hasOtherSessionClaims("project", `/claims/${current}`)).toBe(false);
    });
    for (const member of ["ensureDirectory", "listEntries"] as const) {
        it.each(["ENOENT", "EACCES"])(`propagates ${member} %s rather than returning no claims`, code => {
            for (const method of ["getSessionLockClaimsForContainer", "getSessionLockClaimsForProjectFamily", "getActiveSessionsForContainer", "getActiveSessionsForProjectFamily"] as const) {
                const f = fixture();
                const failure = { code };
                f.ports[member] = () => { throw failure; };
                let caught: unknown;
                try { createSessionClaims(f.ports)[method]("project"); } catch (error) { caught = error; }
                expect(caught).toBe(failure);
                expect(f.batches).toEqual([]);
            }
        });
    }
});

describe("live claims reconciliation", () => {
    it("diagnostic observation excludes stale results while preserving every raw receipt and uncertain owner", () => {
        const unreadable = "project--unreadable.lock";
        const entries = [old, other, current, unreadable];
        const f = fixture(entries, { [old]: versioned(7), [other]: versioned(8), [current]: versioned(42) });
        f.ports.classify = content => content === versioned(7) ? "stale" : content === versioned(8) ? "unknown" : "active";
        const app = createSessionClaims(f.ports);
        expect(app.observeActiveSessionsForContainer("project")).toEqual([other, current, unreadable]);
        expect(f.removals).toEqual([]);
        expect(app.getSessionLockClaimsForContainer("project")).toEqual([old, other, current, unreadable]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${old}`, `read:${other}`, `read:${current}`, `read:${unreadable}`]);
        expect(f.batches).toEqual([[7, 8, 42]]);
    });
    it("diagnostic current-owner comparison omits same-PID legacy results without deleting their receipts", () => {
        const entries = [current, old, other];
        const f = fixture(entries, { [current]: versioned(), [old]: "42", [other]: versioned() });
        const app = createSessionClaims(f.ports);
        expect(app.observeActiveSessionsForContainer("project", `/claims/${current}`)).toEqual([current, other]);
        expect(f.removals).toEqual([]);
        expect(app.getSessionLockClaimsForContainer("project")).toEqual([current, old, other]);
        expect(f.classifications.map(([content]) => content)).toEqual([versioned(), versioned()]);
    });
    it("diagnostic observation selects only the exact profile and preserves classification uncertainty", () => {
        const profiled = "project--p--work--a.lock";
        const sibling = "project--p--work--extra--b.lock";
        const f = fixture([old, profiled, sibling], { [old]: "7", [profiled]: "8", [sibling]: "9" });
        f.ports.classify = () => { throw new Error("observation unavailable"); };
        expect(createSessionClaims(f.ports).observeActiveSessionsForContainer("project--p--work")).toEqual([profiled]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${profiled}`]);
        expect(f.removals).toEqual([]);
    });
    it("reads each candidate once, trims records and passes one exact observation map to every classification", () => {
        const f = fixture([current, old, other, "project--broken.lock"], {
            [current]: ` ${versioned(42)}\r\n`, [old]: " 42\n", [other]: versioned(7), "project--broken.lock": "broken",
        });
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toEqual([current, old, other, "project--broken.lock"]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${current}`, `read:${old}`, `read:${other}`, "read:project--broken.lock"]);
        expect(f.batches).toEqual([[42, 42, 7]]);
        expect(f.classifications.map(([content]) => content)).toEqual([versioned(42), "42", versioned(7), "broken"]);
        for (const [, map] of f.classifications) expect(map).toBe(f.observations);
    });
    it("observes once even when no parseable owner exists and preserves unreadable claims", () => {
        const f = fixture([current, old], { [old]: "broken" });
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toEqual([current, old]);
        expect(f.batches).toEqual([[]]);
        expect(f.classifications.map(([content]) => content)).toEqual(["broken"]);
        expect(f.trace).toContain(`path:${current}`);
        expect(f.removals).toEqual([]);
    });
    it("an empty selection still performs the existing single empty batch", () => {
        const f = fixture(["unrelated--a.lock"]);
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toEqual([]);
        expect(f.batches).toEqual([[]]);
    });
    it.each(["active", "unknown", "stale", "throw"] as const)("retains or excludes a %s candidate without changing the next candidate", result => {
        const f = fixture([old, other], { [old]: versioned(1), [other]: versioned(2) });
        f.ports.classify = content => { if (content === versioned(2)) return "active"; if (result === "throw") throw new Error("classification"); return result; };
        f.ports.removeClaim = path => { f.removals.push(path); throw new Error("sharing violation"); };
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toEqual(result === "stale" ? [other] : [old, other]);
        expect(f.removals).toEqual(result === "stale" ? [`/claims/${old}`] : []);
    });
    it("captures every removal path before classification and targets that path after environment changes", () => {
        const f = fixture([old], { [old]: "42" });
        f.ports.classify = () => { f.ports.claimPath = name => `/new-home/${name}`; return "stale"; };
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toEqual([]);
        expect(f.removals).toEqual([`/claims/${old}`]);
    });
    it("path capture failure propagates even when the candidate is unreadable", () => {
        const f = fixture([old]);
        const failure = new Error("home layout unavailable");
        f.ports.claimPath = () => { throw failure; };
        expect(() => createSessionClaims(f.ports).getActiveSessionsForContainer("project")).toThrow(failure);
        expect(f.batches).toEqual([[]]);
    });
    it("observation failure propagates before path capture, classification or removal", () => {
        const f = fixture([old], { [old]: "42" });
        const failure = { reason: "observation" };
        f.ports.observeOwners = () => { throw failure; };
        let caught: unknown;
        try { createSessionClaims(f.ports).getActiveSessionsForContainer("project"); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.trace).toEqual(["ensure", "list", `read:${old}`]);
        expect(f.classifications).toEqual([]);
        expect(f.removals).toEqual([]);
    });
    it.each([versioned(), "42"])("supplied valid own current record %s prunes only older PID-only claims", record => {
        const f = fixture([current, old, other], { [current]: record, [old]: "42", [other]: versioned() });
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project", `/claims/${current}`)).toEqual([current, other]);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${current}`, `read:${current}`, `read:${old}`, `read:${other}`]);
        expect(f.removals).toEqual([`/claims/${old}`]);
        expect(f.classifications.map(([content]) => content)).toEqual([record, versioned()]);
    });
    it.each(["absent", "unreadable", "malformed", "foreign"])("current hint %s does not supersede a PID-only claim", hint => {
        const records: Record<string, string> = { [old]: "42" };
        if (hint === "malformed") records[current] = "bad";
        if (hint === "foreign") records[current] = "7";
        const f = fixture(hint === "absent" ? [old] : [current, old], records);
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project", `/claims/${current}`)).toEqual(hint === "absent" ? [old] : [current, old]);
        expect(f.removals).toEqual([]);
    });
    it("the preliminary current observation is retained even if its second read fails", () => {
        const f = fixture([current, old], { [old]: "42" });
        let reads = 0;
        const read = f.ports.readClaim;
        f.ports.readClaim = name => { if (name === current && reads++ === 0) return versioned(); return read(name); };
        expect(createSessionClaims(f.ports).getActiveSessionsForContainer("project", `/claims/${current}`)).toEqual([current]);
        expect(f.removals).toEqual([`/claims/${old}`]);
    });
    it("foreign live query intentionally omits the current hint and therefore keeps older same-PID legacy claims", () => {
        const f = fixture([current, old], { [current]: versioned(), [old]: "42" });
        expect(createSessionClaims(f.ports).hasOtherActiveSessions("project", `/claims/${current}`)).toBe(true);
        expect(f.trace.filter(value => value.startsWith("read:"))).toEqual([`read:${current}`, `read:${old}`]);
        expect(f.removals).toEqual([]);
    });
    it("family live query reconciles all double-dash profiles while excluding legacy single-dash claims", () => {
        const profiled = "project--p--work--a.lock";
        const f = fixture([old, profiled, "project-a.lock"], { [old]: "42", [profiled]: "7" });
        expect(createSessionClaims(f.ports).getActiveSessionsForProjectFamily("project")).toEqual([old, profiled]);
        expect(f.batches).toEqual([[42, 7]]);
    });
});

describe("guarded container replacement", () => {
    it("false replacement predicate holds the lock but has no claim observation or pruning effects", () => {
        const f = fixture([old], { [old]: "42" });
        const app = createSessionClaims(f.ports);
        expect(app.recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`, () => { throw new Error("must not recreate"); }, () => {
            expect(f.isHeld()).toBe(true); f.trace.push("predicate"); return false;
        })).toBe(false);
        expect(f.trace).toEqual(["lock:project", "predicate", "unlock:project"]);
    });
    it.each(["active", "unknown"] as SessionLockLiveness[])("a foreign %s claim blocks replacement within the lock", status => {
        const f = fixture([old], { [old]: "42" });
        f.ports.classify = () => { expect(f.isHeld()).toBe(true); return status; };
        expect(createSessionClaims(f.ports).recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`, () => { throw new Error("must not recreate"); })).toBe(false);
        expect(f.trace.at(-1)).toBe("unlock:project");
    });
    it("prunes stale claims and recreates inside the same critical section", () => {
        const f = fixture([current, old], { [current]: versioned(), [old]: "7" });
        f.ports.classify = content => { expect(f.isHeld()).toBe(true); return content === "7" ? "stale" : "active"; };
        expect(createSessionClaims(f.ports).recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`, () => {
            expect(f.isHeld()).toBe(true); expect(f.removals).toEqual([`/claims/${old}`]); f.trace.push("recreate");
        })).toBe(true);
        expect(f.trace.slice(-2)).toEqual(["recreate", "unlock:project"]);
    });
    it.each(["predicate", "enumeration", "recreate"])("propagates %s exception identity and releases the lifecycle lock", stage => {
        const f = fixture();
        const failure = { stage };
        if (stage === "enumeration") f.ports.listEntries = () => { throw failure; };
        let caught: unknown;
        try {
            createSessionClaims(f.ports).recreateContainerWithoutInterruptingSessions("project", `/claims/${current}`,
                () => { if (stage === "recreate") throw failure; }, () => { if (stage === "predicate") throw failure; return true; });
        } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.isHeld()).toBe(false);
        expect(f.trace.at(-1)).toBe("unlock:project");
    });
});
