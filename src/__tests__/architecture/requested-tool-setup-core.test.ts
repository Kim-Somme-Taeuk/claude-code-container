import { describe, expect, it, vi } from "vitest";
import { createRequestedToolSetup } from "../../application/requested-tool-setup.js";
import { CLAUDE_BIN_PATH } from "../../domain/tool-layout.js";
import type { ToolDefinition } from "../../domain/tool-registry.js";
import type { RequestedToolSetupPorts } from "../../ports/requested-tool-setup.js";

const target = "requested target";
function tool(name = "gemini", binary = name): ToolDefinition {
    return { name, binary, displayName: name, defaultFlags: [], credentialMounts: [],
        needsNodeRuntime: false, updateCommand: [], installCommand: "unused" };
}
function ports() {
    return {
        ensureClaudeLauncher: vi.fn<(target: string) => void>(),
        ensureNpmTool: vi.fn<(target: string, originalTool: ToolDefinition) => void>(),
        probeLauncher: vi.fn<RequestedToolSetupPorts["probeLauncher"]>(() => ({ status: 0 })),
        ensureCodexSandbox: vi.fn<(target: string) => void>(),
    };
}
function thrownValue(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected the action to throw");
}

describe("requested tool setup policy", () => {
    const portNames = ["ensureClaudeLauncher", "ensureNpmTool", "probeLauncher", "ensureCodexSandbox"] as const;
    it.each(portNames)("requires callable %s before invoking any port", name => {
        for (const invalid of [undefined, null, false, {}]) {
            const bindings = ports();
            const error = thrownValue(() => createRequestedToolSetup({ ...bindings, [name]: invalid } as unknown as RequestedToolSetupPorts));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toContain(name);
            for (const binding of Object.values(bindings)) expect(binding).not.toHaveBeenCalled();
        }
    });
    it("validates required ports in order and has no construction effects", () => {
        const reads: string[] = [];
        const bindings = ports();
        const observed = Object.fromEntries(portNames.map(name => [name, undefined]));
        for (const name of portNames) Object.defineProperty(observed, name, {
            get() { reads.push(name); return bindings[name]; },
        });
        createRequestedToolSetup(observed as unknown as RequestedToolSetupPorts);
        expect(reads).toEqual(portNames);
        for (const binding of Object.values(bindings)) expect(binding).not.toHaveBeenCalled();
        const error = thrownValue(() => createRequestedToolSetup({} as RequestedToolSetupPorts));
        expect((error as Error).message).toContain(portNames[0]);
    });
    it.each(["claude", "gemini", "codex"])("routes %s by name, probes once and returns undefined", name => {
        const bindings = ports();
        const original = tool(name, "custom-launcher");
        expect(createRequestedToolSetup(bindings).ensure(target, original)).toBeUndefined();
        if (name === "claude") {
            expect(bindings.ensureClaudeLauncher).toHaveBeenCalledExactlyOnceWith(target);
            expect(bindings.ensureNpmTool).not.toHaveBeenCalled();
        } else {
            expect(bindings.ensureNpmTool).toHaveBeenCalledExactlyOnceWith(target, original);
            expect(bindings.ensureNpmTool.mock.calls[0][1]).toBe(original);
            expect(bindings.ensureClaudeLauncher).not.toHaveBeenCalled();
        }
        expect(bindings.probeLauncher).toHaveBeenCalledExactlyOnceWith(target,
            name === "claude" ? CLAUDE_BIN_PATH : "/home/ccc/.local/bin/custom-launcher");
        if (name === "codex") expect(bindings.ensureCodexSandbox).toHaveBeenCalledExactlyOnceWith(target);
        else expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });
    it.each(["launcher", ""])("reads binary after installation and preserves its truthiness (%s)", binary => {
        const bindings = ports();
        const original = tool();
        bindings.ensureNpmTool.mockImplementation((_target, received) => {
            expect(received).toBe(original);
            received.name = "changed";
            received.binary = binary;
        });
        createRequestedToolSetup(bindings).ensure(target, original);
        expect(bindings.probeLauncher).toHaveBeenCalledExactlyOnceWith(target, `/home/ccc/.local/bin/${binary || "changed"}`);
    });
    it("reads the binary even for Claude and uses the freshly read name for its path", () => {
        const bindings = ports();
        const original = tool("claude");
        const trace: string[] = [];
        Object.defineProperty(original, "name", { get() { trace.push("name"); return "claude"; } });
        Object.defineProperty(original, "binary", { get() { trace.push("binary"); return "override"; } });
        bindings.ensureClaudeLauncher.mockImplementation(() => { trace.push("install"); });
        bindings.probeLauncher.mockImplementation(() => { trace.push("probe"); return { status: 0 }; });
        createRequestedToolSetup(bindings).ensure(target, original);
        expect(trace).toEqual(["name", "install", "binary", "name", "probe", "name"]);
        expect(bindings.probeLauncher).toHaveBeenCalledWith(target, CLAUDE_BIN_PATH);
    });
    it("uses the current name after install for the Claude path and after readiness for Codex", () => {
        const bindings = ports();
        const original = tool("gemini");
        bindings.ensureNpmTool.mockImplementation(() => { original.name = "claude"; });
        bindings.probeLauncher.mockImplementation(() => { original.name = "codex"; return { status: 0 }; });
        createRequestedToolSetup(bindings).ensure(target, original);
        expect(bindings.probeLauncher).toHaveBeenCalledWith(target, CLAUDE_BIN_PATH);
        expect(bindings.ensureCodexSandbox).toHaveBeenCalledExactlyOnceWith(target);
    });
    it("reads a fallback name separately from the subsequent path name", () => {
        const bindings = ports();
        const original = tool("gemini", "");
        const names = ["gemini", "fallback", "claude", "gemini"];
        const trace: string[] = [];
        Object.defineProperty(original, "name", { get() { trace.push("name"); return names.shift(); } });
        Object.defineProperty(original, "binary", { get() { trace.push("binary"); return ""; } });
        bindings.ensureNpmTool.mockImplementation(() => { trace.push("install"); });
        bindings.probeLauncher.mockImplementation(() => { trace.push("probe"); return { status: 0 }; });
        createRequestedToolSetup(bindings).ensure(target, original);
        expect(trace).toEqual(["name", "install", "binary", "name", "name", "probe", "name"]);
        expect(names).toEqual([]);
        expect(bindings.probeLauncher).toHaveBeenCalledExactlyOnceWith(target, CLAUDE_BIN_PATH);
    });
    it("does not retain an earlier Codex name for the sandbox postcondition", () => {
        const bindings = ports();
        const original = tool("codex");
        bindings.probeLauncher.mockImplementation(() => { original.name = "gemini"; return { status: 0 }; });
        createRequestedToolSetup(bindings).ensure(target, original);
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });
    it.each([1, 124, 137, null, undefined])("reports status %s as unavailable, with no sandbox", status => {
        const bindings = ports();
        bindings.probeLauncher.mockReturnValue({ status } as ReturnType<RequestedToolSetupPorts["probeLauncher"]>);
        expect(() => createRequestedToolSetup(bindings).ensure(target, tool("codex")))
            .toThrow("Requested tool codex is unavailable after setup");
        expect(bindings.probeLauncher).toHaveBeenCalledTimes(1);
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });
    it.each([{ code: "ETIMEDOUT" }, { code: "EIO" }, true, "error"])("classifies raw error %j without reading status", error => {
        const bindings = ports();
        const status = vi.fn<() => never>(() => { throw new Error("status should be short-circuited"); });
        bindings.probeLauncher.mockReturnValue({ error, get status() { return status(); } });
        expect(() => createRequestedToolSetup(bindings).ensure(target, tool("codex"))).toThrow(
            typeof error === "object" && error.code === "ETIMEDOUT"
                ? "Requested tool codex readiness check timed out" : "Requested tool codex is unavailable after setup");
        expect(status).not.toHaveBeenCalled();
        expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
    });
    it.each([undefined, null, false, 0, ""])("permits falsey error %j with a successful status", error => {
        const bindings = ports();
        bindings.probeLauncher.mockReturnValue({ status: 0, error });
        expect(createRequestedToolSetup(bindings).ensure(target, tool())).toBeUndefined();
    });
    it("reads the raw error twice and preserves optional chaining and status short-circuiting", () => {
        const bindings = ports();
        const trace: string[] = [];
        let reads = 0;
        bindings.probeLauncher.mockReturnValue({
            get error() { trace.push("error"); return ++reads === 1 ? null : { code: "ETIMEDOUT" }; },
            get status(): never { trace.push("status"); throw new Error("unreachable status"); },
        });
        expect(() => createRequestedToolSetup(bindings).ensure(target, tool())).toThrow("Requested tool gemini is unavailable after setup");
        expect(trace).toEqual(["error", "error"]);
    });
    it("does not cache the error getter before a successful status read", () => {
        const bindings = ports();
        const trace: string[] = [];
        bindings.probeLauncher.mockReturnValue({
            get error() { trace.push("error"); return undefined; },
            get status() { trace.push("status"); return 0; },
        });
        createRequestedToolSetup(bindings).ensure(target, tool());
        expect(trace).toEqual(["error", "error", "status"]);
    });
    it.each(["claude", "npm", "binary", "name", "probe", "error", "code", "status", "sandbox"])(
        "propagates the original thrown value at %s and stops later effects", stage => {
            const bindings = ports();
            const original = tool(stage === "claude" ? "claude" : "codex");
            const failure = { stage };
            const fail = () => { throw failure; };
            if (stage === "claude") bindings.ensureClaudeLauncher.mockImplementation(fail);
            if (stage === "npm") bindings.ensureNpmTool.mockImplementation(fail);
            if (stage === "binary") Object.defineProperty(original, "binary", { get: fail });
            if (stage === "name") Object.defineProperty(original, "name", { get: fail });
            if (stage === "probe") bindings.probeLauncher.mockImplementation(fail);
            if (stage === "error") bindings.probeLauncher.mockReturnValue({ status: 0, get error() { return fail(); } });
            if (stage === "code") bindings.probeLauncher.mockReturnValue({ status: 0, error: { get code() { return fail(); } } });
            if (stage === "status") bindings.probeLauncher.mockReturnValue({ get status() { return fail(); } });
            if (stage === "sandbox") bindings.ensureCodexSandbox.mockImplementation(fail);
            expect(thrownValue(() => createRequestedToolSetup(bindings).ensure(target, original))).toBe(failure);
            if (["claude", "npm", "binary", "name"].includes(stage)) expect(bindings.probeLauncher).not.toHaveBeenCalled();
            if (stage !== "sandbox") expect(bindings.ensureCodexSandbox).not.toHaveBeenCalled();
            else expect(bindings.probeLauncher).toHaveBeenCalledExactlyOnceWith(target, "/home/ccc/.local/bin/codex");
        });
});
