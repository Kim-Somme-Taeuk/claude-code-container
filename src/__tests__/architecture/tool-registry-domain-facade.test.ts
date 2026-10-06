import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDefaultToolCatalog, findToolByName, findDefaultTool,
    getAllCredentialMounts, getNpmTools, type ToolDefinition,
} from "../../domain/tool-registry.js";

type Registry = typeof import("../../tool-registry.js");

// Restore original descriptors and every nested array even after a failed assertion.
function restoreGraph(root: object): () => void {
    const originals = new Map<object, PropertyDescriptorMap>();
    const capture = (value: object): void => {
        if (originals.has(value)) return;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        originals.set(value, descriptors);
        for (const descriptor of Object.values(descriptors)) {
            if (descriptor.value !== null && typeof descriptor.value === "object") capture(descriptor.value);
        }
    };
    capture(root);
    return () => {
        for (const [value, descriptors] of originals) {
            for (const key of Reflect.ownKeys(value)) {
                if (!Object.prototype.hasOwnProperty.call(descriptors, key)) Reflect.deleteProperty(value, key);
            }
            Object.defineProperties(value, descriptors);
        }
    };
}

async function withRegistry(action: (registry: Registry, catalog: ToolDefinition[]) => void): Promise<void> {
    vi.resetModules();
    const registry = await import("../../tool-registry.js");
    const catalog = registry.getAllTools();
    const restore = restoreGraph(catalog);
    try { action(registry, catalog); } finally { restore(); }
}

function thrownBy(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected the facade to throw");
}

afterEach(() => {
    vi.doUnmock("../../container-setup.js");
    vi.doUnmock("child_process");
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
    vi.resetModules();
});

describe("actual tool registry compatibility facade", () => {
    it("imports without installer or native dependencies and shares one catalog across all getters", async () => {
        vi.doMock("../../container-setup.js", () => { throw new Error("facade imported installer"); });
        vi.doMock("child_process", () => { throw new Error("facade imported native process"); });
        vi.doMock("node:child_process", () => { throw new Error("facade imported native process"); });
        await withRegistry((registry, catalog) => {
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getDefaultTool()).toBe(catalog[0]);
            for (const value of catalog) expect(registry.getToolByName(value.name)).toBe(value);
            expect(registry.getAllCredentialMounts()).toEqual(getAllCredentialMounts(catalog));
            expect(registry.getNpmTools()).toEqual(getNpmTools(catalog));
            const independent = createDefaultToolCatalog();
            expect(independent).toEqual(catalog);
            expect(independent).not.toBe(catalog);
            expect(independent[0]).not.toBe(registry.getDefaultTool());
        });
    });

    it("observes push, splice, reordering, renames and removal through every public query", async () => {
        await withRegistry((registry, catalog) => {
            const added = createDefaultToolCatalog()[1];
            added.name = "custom";
            catalog.push(added);
            expect(registry.getToolByName("custom")).toBe(added);
            expect(registry.getNpmTools().at(-1)).toEqual({ cmd: "custom", pkg: "@google/gemini-cli" });
            expect(registry.getAllCredentialMounts().at(-1)).toBe(added.credentialMounts[0]);
            const duplicate = createDefaultToolCatalog()[1];
            duplicate.name = "custom";
            catalog.unshift(duplicate);
            expect(registry.getToolByName("custom")).toBe(duplicate);
            catalog.reverse();
            expect(registry.getToolByName("custom")).toBe(added);
            const claude = registry.getDefaultTool();
            claude.name = "renamed";
            expect(registry.getDefaultTool()).toBeUndefined();
            expect(registry.getToolByName("renamed")).toBe(claude);
            claude.name = "claude";
            expect(registry.getDefaultTool()).toBe(claude);
            catalog.splice(catalog.indexOf(claude), 1);
            expect(registry.getDefaultTool()).toBeUndefined();
            expect(registry.getToolByName("claude")).toBeUndefined();
            for (const name of ["", "CLAUDE", "missing"]) expect(registry.getToolByName(name)).toBeUndefined();
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getToolByName("custom")).toBe(findToolByName(catalog, "custom"));
            expect(registry.getDefaultTool()).toBe(findDefaultTool(catalog));
            catalog.splice(0);
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getAllCredentialMounts()).toEqual([]);
            expect(registry.getNpmTools()).toEqual([]);
            expect(registry.getDefaultTool()).toBeUndefined();
        });
    });

    it("preserves fresh projections, shared mount objects and descriptor field mutation", async () => {
        await withRegistry((registry, catalog) => {
            const mounts = registry.getAllCredentialMounts();
            const next = registry.getAllCredentialMounts();
            expect(next).not.toBe(mounts);
            for (let index = 0; index < mounts.length; index++) expect(next[index]).toBe(mounts[index]);
            mounts[0].hostDir = "mutated";
            expect(catalog[0].credentialMounts[0].hostDir).toBe("mutated");
            expect(registry.getAllCredentialMounts()[0].hostDir).toBe("mutated");
            mounts.pop();
            expect(registry.getAllCredentialMounts()).toHaveLength(next.length);
            const npm = registry.getNpmTools(), again = registry.getNpmTools();
            expect(again).not.toBe(npm);
            for (let index = 0; index < npm.length; index++) expect(again[index]).not.toBe(npm[index]);
            npm[0].pkg = "only projection";
            expect(registry.getNpmTools()[0].pkg).toBe("@google/gemini-cli");
            catalog[1].name = "new-name";
            catalog[1].binary = "different-binary";
            catalog[1].installCommand = "npm install -g npm install -g custom";
            expect(registry.getNpmTools()[0]).toEqual({ cmd: "new-name", pkg: "npm install -g custom" });
            catalog[1].installCommand = "npm install -g ";
            expect(registry.getNpmTools()[0].pkg).toBe("");
            catalog[1].installCommand = " npm install -g excluded";
            expect(registry.getNpmTools().some(value => value.cmd === "new-name")).toBe(false);
        });
    });

    it("preserves getter order, short circuit and filter-before-map evaluation", async () => {
        await withRegistry((registry, catalog) => {
            const trace: string[] = [];
            const values = createDefaultToolCatalog().slice(0, 3);
            for (const value of values) {
                const { name, credentialMounts, installCommand } = value;
                Object.defineProperties(value, {
                    name: { get() { trace.push(`${name}.name`); return name; } },
                    credentialMounts: { get() { trace.push(`${name}.mounts`); return credentialMounts; } },
                    installCommand: { get() { trace.push(`${name}.install`); return installCommand; } },
                });
            }
            catalog.splice(0, catalog.length, ...values);
            expect(registry.getToolByName("gemini")).toBe(values[1]);
            expect(trace).toEqual(["claude.name", "gemini.name"]);
            trace.length = 0;
            expect(registry.getDefaultTool()).toBe(values[0]);
            expect(trace).toEqual(["claude.name"]);
            trace.length = 0;
            registry.getAllCredentialMounts();
            expect(trace).toEqual(["claude.mounts", "gemini.mounts", "codex.mounts"]);
            trace.length = 0;
            expect(registry.getNpmTools()).toEqual([{ cmd: "gemini", pkg: "@google/gemini-cli" },
                { cmd: "codex", pkg: "@openai/codex" }]);
            expect(trace).toEqual(["claude.install", "gemini.install", "codex.install",
                "gemini.name", "gemini.install", "codex.name", "codex.install"]);
        });
    });

    it.each(["find-name", "find-default", "flatMap", "filter-map"])("keeps live Array receivers and raw returns (%s)", async mode => {
        await withRegistry((registry, catalog) => {
            const result = { raw: true }, trace: string[] = [];
            if (mode.startsWith("find")) {
                Object.defineProperty(catalog, "find", { configurable: true, get() {
                    trace.push("find.get");
                    return function (this: unknown) { expect(this).toBe(catalog); trace.push("find.call"); return result; };
                } });
                expect(mode === "find-name" ? registry.getToolByName("x") : registry.getDefaultTool()).toBe(result);
                expect(trace).toEqual(["find.get", "find.call"]);
            } else if (mode === "flatMap") {
                Object.defineProperty(catalog, "flatMap", { configurable: true, get() {
                    trace.push("flatMap.get");
                    return function (this: unknown) { expect(this).toBe(catalog); trace.push("flatMap.call"); return result; };
                } });
                expect(registry.getAllCredentialMounts()).toBe(result);
                expect(trace).toEqual(["flatMap.get", "flatMap.call"]);
            } else {
                const filtered = { get map() {
                    trace.push("map.get");
                    return function (this: unknown) { expect(this).toBe(filtered); trace.push("map.call"); return result; };
                } };
                Object.defineProperty(catalog, "filter", { configurable: true, get() {
                    trace.push("filter.get");
                    return function (this: unknown) { expect(this).toBe(catalog); trace.push("filter.call"); return filtered; };
                } });
                expect(registry.getNpmTools()).toBe(result);
                expect(trace).toEqual(["filter.get", "filter.call", "map.get", "map.call"]);
            }
        });
    });

    it.each(["error", "non-error"])("forwards field/method/string failures without changing identity (%s)", async kind => {
        const sentinel = kind === "error" ? new Error("sentinel") : { sentinel: true };
        for (const [field, action] of [
            ["name", (registry: Registry) => registry.getToolByName("x")],
            ["name", (registry: Registry) => registry.getDefaultTool()],
            ["name", (registry: Registry) => registry.getNpmTools()],
            ["credentialMounts", (registry: Registry) => registry.getAllCredentialMounts()],
            ["installCommand", (registry: Registry) => registry.getNpmTools()],
        ] as const) await withRegistry((registry, catalog) => {
            const value = createDefaultToolCatalog()[1];
            Object.defineProperty(value, field, { get() { throw sentinel; } });
            catalog.splice(0, catalog.length, value);
            expect(thrownBy(() => action(registry))).toBe(sentinel);
        });
        for (const [method, action] of [
            ["find", (registry: Registry) => registry.getToolByName("x")],
            ["find", (registry: Registry) => registry.getDefaultTool()],
            ["flatMap", (registry: Registry) => registry.getAllCredentialMounts()],
            ["filter", (registry: Registry) => registry.getNpmTools()],
        ] as const) for (const getter of [false, true]) await withRegistry((registry, catalog) => {
            Object.defineProperty(catalog, method, { configurable: true, ...(getter ? { get() { throw sentinel; } }
                : { value() { throw sentinel; } }) });
            expect(thrownBy(() => action(registry))).toBe(sentinel);
        });
        for (const method of ["startsWith", "replace"]) await withRegistry((registry, catalog) => {
            const command = { startsWith() { return true; }, replace() { return "pkg"; } };
            Object.defineProperty(command, method, { value() { throw sentinel; } });
            const value = createDefaultToolCatalog()[1];
            Object.defineProperty(value, "installCommand", { value: command });
            catalog.splice(0, catalog.length, value);
            expect(thrownBy(() => registry.getNpmTools())).toBe(sentinel);
        });
        await withRegistry((registry, catalog) => {
            const filtered = { map() { throw sentinel; } };
            Object.defineProperty(catalog, "filter", { configurable: true, value() { return filtered; } });
            expect(thrownBy(() => registry.getNpmTools())).toBe(sentinel);
        });
    });
});
