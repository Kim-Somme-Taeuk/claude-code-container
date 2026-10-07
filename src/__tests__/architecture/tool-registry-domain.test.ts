import { describe, expect, it } from "vitest";
import {
    createDefaultToolCatalog, findToolByName, findDefaultTool,
    getAllCredentialMounts, getNpmTools, type ToolDefinition,
} from "../../domain/tool-registry.js";

function tool(name: string, installCommand = "other installer"): ToolDefinition {
    return { name, displayName: name, binary: `binary-${name}`, defaultFlags: [],
        credentialMounts: [], needsNodeRuntime: false, updateCommand: [], installCommand };
}

function expectFreshGraph(first: unknown, second: unknown): void {
    expect(first).toEqual(second);
    if (first !== null && typeof first === "object") {
        expect(first).not.toBe(second);
        for (const key of Object.keys(first)) {
            expectFreshGraph((first as Record<string, unknown>)[key],
                (second as Record<string, unknown>)[key]);
        }
    }
}

function thrownBy(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected the selector to throw");
}

function tracedTool(name: string, command: string, trace: string[]): ToolDefinition {
    const value = tool(name, command);
    Object.defineProperties(value, {
        name: { get() { trace.push(`${name}.name`); return name; } },
        installCommand: { get() { trace.push(`${name}.installCommand`); return command; } },
        credentialMounts: { get() { trace.push(`${name}.credentialMounts`); return []; } },
    });
    return value;
}

describe("explicit tool catalog domain", () => {
    it("constructs deeply independent default graphs with preserved optional metadata", () => {
        const first = createDefaultToolCatalog();
        const second = createDefaultToolCatalog();
        expectFreshGraph(first, second);
        expect(first.map(value => value.name)).toEqual(["claude", "gemini", "codex", "opencode"]);
        const before = structuredClone(second);
        for (const value of first) {
            value.name = "changed";
            value.defaultFlags.push("changed");
            value.updateCommand.push("changed");
            value.credentialMounts[0].hostDir = "changed";
            value.credentialMounts.push({ hostDir: "new", containerDir: "/new" });
            value.subcommands?.push("changed");
            value.subcommandsAcceptingDefaultFlags?.push("changed");
        }
        first.splice(0, 1);
        expect(second).toEqual(before);
        expect(createDefaultToolCatalog()).toEqual(before);
    });

    it("selects only from the supplied catalog and observes order and mutations", () => {
        const first = tool("duplicate"), last = tool("duplicate"), claude = tool("claude");
        const catalog = [first, claude, last];
        expect(findToolByName(catalog, "duplicate")).toBe(first);
        expect(findDefaultTool(catalog)).toBe(claude);
        expect(findToolByName([], "claude")).toBeUndefined();
        expect(findDefaultTool([])).toBeUndefined();
        for (const name of ["", "CLAUDE", "unknown"]) expect(findToolByName(catalog, name)).toBeUndefined();
        catalog.reverse();
        expect(findToolByName(catalog, "duplicate")).toBe(last);
        claude.name = "renamed";
        expect(findDefaultTool(catalog)).toBeUndefined();
        expect(findToolByName(catalog, "renamed")).toBe(claude);
        catalog.push(tool("claude"));
        expect(findDefaultTool(catalog)).toBe(catalog[3]);
        const anotherClaude = tool("claude");
        catalog.unshift(anotherClaude);
        expect(findDefaultTool(catalog)).toBe(anotherClaude);
    });

    it("flattens mounts in catalog order with fresh arrays and shared mount identities", () => {
        const first = tool("one"), second = tool("two");
        const mount = { hostDir: "relative", containerDir: "/absolute" };
        const other = { hostDir: "other", containerDir: "/other" };
        first.credentialMounts = [mount, other]; second.credentialMounts = [mount];
        const catalog = [first, second];
        const mounts = getAllCredentialMounts(catalog);
        expect(mounts).toEqual([mount, other, mount]);
        expect(mounts[0]).toBe(mount); expect(mounts[1]).toBe(other); expect(mounts[2]).toBe(mount);
        expect(getAllCredentialMounts(catalog)).not.toBe(mounts);
        mounts.pop();
        expect(second.credentialMounts).toEqual([mount]);
        mount.hostDir = "changed";
        expect(getAllCredentialMounts(catalog)[2].hostDir).toBe("changed");
        expect(getAllCredentialMounts([])).toEqual([]);
        catalog.reverse();
        expect(getAllCredentialMounts(catalog)).toEqual([mount, mount, other]);
    });

    it("projects exact npm prefixes and name rather than binary without mutating input", () => {
        const catalog = [tool("a", "npm install -g package"), tool("b", " npm install -g ignored"),
            tool("c", "npm install -g "), tool("d", "npm install -g npm install -g twice"),
            tool("e", "npm install -g"), tool("f", "NPM install -g ignored"), tool("g", "echo npm install -g ignored")];
        const before = structuredClone(catalog);
        const projected = getNpmTools(catalog);
        expect(projected).toEqual([{ cmd: "a", pkg: "package" }, { cmd: "c", pkg: "" },
            { cmd: "d", pkg: "npm install -g twice" }]);
        expect(catalog).toEqual(before);
        const again = getNpmTools(catalog);
        expect(again).not.toBe(projected);
        for (let index = 0; index < again.length; index++) expect(again[index]).not.toBe(projected[index]);
        projected[0].pkg = "changed";
        expect(getNpmTools(catalog)[0].pkg).toBe("package");
        expect(getNpmTools([])).toEqual([]);
    });

    it("reads selection names in order and stops at the first match", () => {
        const trace: string[] = [];
        const first = tracedTool("first", "", trace), claude = tracedTool("claude", "", trace);
        const last = tracedTool("last", "", trace), catalog = [first, claude, last];
        expect(findToolByName(catalog, "claude")).toBe(claude);
        expect(trace).toEqual(["first.name", "claude.name"]);
        trace.length = 0;
        expect(findDefaultTool(catalog)).toBe(claude);
        expect(trace).toEqual(["first.name", "claude.name"]);
        trace.length = 0;
        expect(findToolByName(catalog, "absent")).toBeUndefined();
        expect(trace).toEqual(["first.name", "claude.name", "last.name"]);
    });

    it("preserves mount reads and filter-before-map name/command reads", () => {
        const trace: string[] = [];
        const catalog = [tracedTool("one", "npm install -g first", trace),
            tracedTool("skip", "different", trace), tracedTool("two", "npm install -g second", trace)];
        expect(getAllCredentialMounts(catalog)).toEqual([]);
        expect(trace).toEqual(["one.credentialMounts", "skip.credentialMounts", "two.credentialMounts"]);
        trace.length = 0;
        expect(getNpmTools(catalog)).toEqual([{ cmd: "one", pkg: "first" }, { cmd: "two", pkg: "second" }]);
        expect(trace).toEqual(["one.installCommand", "skip.installCommand", "two.installCommand",
            "one.name", "one.installCommand", "two.name", "two.installCommand"]);
    });

    it.each(["find-name", "find-default", "flatMap", "filter-map"])("uses live methods and receivers (%s)", mode => {
        const catalog = [tool("claude", "npm install -g package")];
        const trace: string[] = [];
        const result = { unusual: true };
        if (mode.startsWith("find")) {
            Object.defineProperty(catalog, "find", { get() {
                trace.push("find.get");
                return function (this: unknown) { expect(this).toBe(catalog); trace.push("find.call"); return result; };
            } });
            expect(mode === "find-name" ? findToolByName(catalog, "claude") : findDefaultTool(catalog)).toBe(result);
            expect(trace).toEqual(["find.get", "find.call"]);
        } else if (mode === "flatMap") {
            Object.defineProperty(catalog, "flatMap", { get() {
                trace.push("flatMap.get");
                return function (this: unknown) { expect(this).toBe(catalog); trace.push("flatMap.call"); return result; };
            } });
            expect(getAllCredentialMounts(catalog)).toBe(result);
            expect(trace).toEqual(["flatMap.get", "flatMap.call"]);
        } else {
            const filtered = { get map() {
                trace.push("map.get");
                return function (this: unknown) { expect(this).toBe(filtered); trace.push("map.call"); return result; };
            } };
            Object.defineProperty(catalog, "filter", { get() {
                trace.push("filter.get");
                return function (this: unknown) { expect(this).toBe(catalog); trace.push("filter.call"); return filtered; };
            } });
            expect(getNpmTools(catalog)).toBe(result);
            expect(trace).toEqual(["filter.get", "filter.call", "map.get", "map.call"]);
        }
    });

    it("keeps install string method receivers, exact arguments and unnormalized results", () => {
        const trace: string[] = [];
        const pkg = { unusual: true };
        const command = {
            startsWith(this: unknown, prefix: string) {
                expect(this).toBe(command); expect(prefix).toBe("npm install -g ");
                trace.push("startsWith"); return "truthy";
            },
            replace(this: unknown, prefix: string, replacement: string) {
                expect(this).toBe(command); expect([prefix, replacement]).toEqual(["npm install -g ", ""]);
                trace.push("replace"); return pkg;
            },
        };
        const value = tool("custom");
        Object.defineProperty(value, "installCommand", { get() { trace.push("installCommand"); return command; } });
        const result = getNpmTools([value]);
        expect(result[0].cmd).toBe("custom"); expect(result[0].pkg).toBe(pkg);
        expect(trace).toEqual(["installCommand", "startsWith", "installCommand", "replace"]);
    });

    it.each(["error", "non-error"])("propagates method and field failures unchanged (%s)", kind => {
        const sentinel = kind === "error" ? new Error("sentinel") : { sentinel: true };
        for (const [field, action] of [
            ["name", (catalog: ToolDefinition[]) => findToolByName(catalog, "x")],
            ["name", findDefaultTool], ["name", getNpmTools],
            ["credentialMounts", getAllCredentialMounts], ["installCommand", getNpmTools],
        ] as const) {
            const value = tool("x", "npm install -g package");
            Object.defineProperty(value, field, { get() { throw sentinel; } });
            expect(thrownBy(() => action([value]))).toBe(sentinel);
        }
        for (const [method, action] of [
            ["find", (catalog: ToolDefinition[]) => findToolByName(catalog, "x")],
            ["find", findDefaultTool], ["flatMap", getAllCredentialMounts], ["filter", getNpmTools],
        ] as const) for (const accessor of [false, true]) {
            const catalog = [tool("x")];
            Object.defineProperty(catalog, method, accessor ? { get() { throw sentinel; } }
                : { value() { throw sentinel; } });
            expect(thrownBy(() => action(catalog))).toBe(sentinel);
        }
        for (const accessor of [false, true]) {
            const filtered = {};
            Object.defineProperty(filtered, "map", accessor ? { get() { throw sentinel; } }
                : { value() { throw sentinel; } });
            const catalog = [tool("x")];
            Object.defineProperty(catalog, "filter", { value() { return filtered; } });
            expect(thrownBy(() => getNpmTools(catalog))).toBe(sentinel);
        }
        for (const method of ["startsWith", "replace"]) for (const accessor of [false, true]) {
            const command = { startsWith() { return true; }, replace() { return "pkg"; } };
            Object.defineProperty(command, method, accessor ? { get() { throw sentinel; } }
                : { value() { throw sentinel; } });
            const value = tool("x");
            Object.defineProperty(value, "installCommand", { value: command });
            expect(thrownBy(() => getNpmTools([value]))).toBe(sentinel);
        }
    });
});
