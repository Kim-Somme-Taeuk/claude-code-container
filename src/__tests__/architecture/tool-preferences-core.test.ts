import { describe, expect, it, vi } from "vitest";
import { createDefaultToolCatalog, findToolByName, type ToolDefinition } from "../../domain/tool-registry.js";
import { createToolPreferences } from "../../application/tool-preferences.js";
import type { ToolPreferencePorts } from "../../ports/tool-preferences.js";

const catalog = createDefaultToolCatalog();
const tool = (name: string) => findToolByName(catalog, name)!;
const portNames = ["readToolOverride", "readSavedDefaultTool", "saveDefaultTool", "findTool", "getDefaultTool"] as const;

function recordingPorts(override: string | undefined, saved: unknown, overrides: Partial<ToolPreferencePorts> = {}) {
    const log: string[] = [];
    const ports: ToolPreferencePorts = {
        readToolOverride: vi.fn(() => { log.push("override"); return override; }),
        readSavedDefaultTool: vi.fn(() => { log.push("read"); return saved; }),
        saveDefaultTool: vi.fn((name: string) => { log.push(`save:${name}`); }),
        findTool: vi.fn((name: string) => { log.push(`find:${name}`); return findToolByName(catalog, name); }),
        getDefaultTool: vi.fn(() => { log.push("default"); return tool("claude"); }),
        ...overrides,
    };
    return { ports, log };
}

function thrown(operation: () => unknown): unknown {
    try {
        operation();
    } catch (error) {
        return error;
    }
    throw new Error("expected the operation to throw");
}

describe("tool preference application construction", () => {
    it.each([undefined, null])("rejects absent port objects (%s)", value => {
        expect(() => createToolPreferences(value as unknown as ToolPreferencePorts)).toThrow(TypeError);
    });

    for (const member of portNames) {
        it.each([undefined, null, 1, "x", {}])(`rejects noncallable ${member} (%s) before any port runs`, value => {
            const { ports, log } = recordingPorts("gemini", "codex");
            expect(() => createToolPreferences({ ...ports, [member]: value } as unknown as ToolPreferencePorts))
                .toThrow(new TypeError(`Tool preferences requires a callable ${member} port.`));
            expect(log).toEqual([]);
        });
    }

    it("construction reads no port", () => {
        const { ports, log } = recordingPorts("gemini", "codex");
        createToolPreferences(ports);
        expect(log).toEqual([]);
    });
});

describe("saved preference decoding", () => {
    it.each(["codex", "", "unknown-xyz", " Gemini "])("returns string %j unchanged after one read", value => {
        const { ports, log } = recordingPorts("gemini", value);
        expect(createToolPreferences(ports).getDefaultToolPreference()).toBe(value);
        expect(log).toEqual(["read"]);
    });

    it.each([undefined, null, 1, true, {}, ["codex"]])("returns null for non-string %j after one read", value => {
        const { ports, log } = recordingPorts("gemini", value);
        expect(createToolPreferences(ports).getDefaultToolPreference()).toBeNull();
        expect(log).toEqual(["read"]);
    });

    it.each([new Error("read"), { reason: "non-error" }])("propagates read failure %s by identity", failure => {
        const { ports } = recordingPorts(undefined, undefined, { readSavedDefaultTool: () => { throw failure; } });
        expect(thrown(() => createToolPreferences(ports).getDefaultToolPreference())).toBe(failure);
    });
});

describe("saving a preference", () => {
    it("saves the name exactly once without validation or reads", () => {
        const { ports, log } = recordingPorts("gemini", "codex");
        expect(createToolPreferences(ports).setDefaultToolPreference(" not-a-tool ")).toBeUndefined();
        expect(log).toEqual(["save: not-a-tool "]);
    });

    it.each([new Error("refused"), "string failure"])("rethrows save failure %s by identity", failure => {
        const { ports } = recordingPorts(undefined, undefined, { saveDefaultTool: () => { throw failure; } });
        expect(thrown(() => createToolPreferences(ports).setDefaultToolPreference("codex"))).toBe(failure);
    });
});

describe("tool resolution order", () => {
    it("a known override wins without reading the saved preference", () => {
        const { ports, log } = recordingPorts("gemini", "codex");
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("gemini"));
        expect(log).toEqual(["override", "find:gemini"]);
    });

    it("an unknown override falls to a known saved preference with one read", () => {
        const { ports, log } = recordingPorts("nope", "codex");
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("codex"));
        expect(log).toEqual(["override", "find:nope", "read", "find:codex"]);
    });

    it.each([["absent", undefined], ["empty", ""]] as const)("%s override skips the override lookup", (_label, override) => {
        const { ports, log } = recordingPorts(override, "opencode");
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("opencode"));
        expect(log).toEqual(["override", "read", "find:opencode"]);
    });

    it("does not normalize names", () => {
        const { ports, log } = recordingPorts("Gemini", " codex");
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("claude"));
        expect(log).toEqual(["override", "find:Gemini", "read", "find: codex", "default"]);
    });

    it.each([
        ["empty string", ""], ["null", null], ["number", 7], ["undefined", undefined], ["object", {}],
    ] as const)("saved %s skips lookup and falls back to the default port", (_label, saved) => {
        const { ports, log } = recordingPorts(undefined, saved);
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("claude"));
        expect(log).toEqual(["override", "read", "default"]);
    });

    it("an unknown saved name is looked up once before the default port", () => {
        const { ports, log } = recordingPorts(undefined, "unknown-xyz");
        expect(createToolPreferences(ports).resolveTool()).toBe(tool("claude"));
        expect(log).toEqual(["override", "read", "find:unknown-xyz", "default"]);
    });

    it("passes a missing default through as undefined", () => {
        const { ports } = recordingPorts(undefined, null, { getDefaultTool: () => undefined as unknown as ToolDefinition });
        expect(createToolPreferences(ports).resolveTool()).toBeUndefined();
    });

    it.each([new Error("override"), "non-error override"])("override read failure %s propagates before any other port", failure => {
        const { ports, log } = recordingPorts(undefined, "codex", { readToolOverride: () => { throw failure; } });
        expect(thrown(() => createToolPreferences(ports).resolveTool())).toBe(failure);
        expect(log).toEqual([]);
    });

    it("override lookup failure propagates without reading the saved preference", () => {
        const failure = new Error("lookup");
        const { ports, log } = recordingPorts("gemini", "codex", {
            findTool: (name: string) => { log.push(`find:${name}`); throw failure; },
        });
        expect(thrown(() => createToolPreferences(ports).resolveTool())).toBe(failure);
        expect(log).toEqual(["override", "find:gemini"]);
    });

    it("saved-name lookup failure propagates without the default port", () => {
        const failure = { reason: "saved lookup" };
        const { ports, log } = recordingPorts("nope", "codex", {
            findTool: (name: string) => {
                log.push(`find:${name}`);
                if (name === "codex") throw failure;
                return undefined;
            },
        });
        expect(thrown(() => createToolPreferences(ports).resolveTool())).toBe(failure);
        expect(log).toEqual(["override", "find:nope", "read", "find:codex"]);
    });

    it("saved read failure propagates without lookup or default", () => {
        const failure = new Error("read");
        const { ports, log } = recordingPorts(undefined, undefined, { readSavedDefaultTool: () => { log.push("read"); throw failure; } });
        expect(thrown(() => createToolPreferences(ports).resolveTool())).toBe(failure);
        expect(log).toEqual(["override", "read"]);
    });

    it.each([new Error("default"), "non-error default"])("default port failure %s propagates by identity", failure => {
        const { ports } = recordingPorts(undefined, null, { getDefaultTool: () => { throw failure; } });
        expect(thrown(() => createToolPreferences(ports).resolveTool())).toBe(failure);
    });
});
