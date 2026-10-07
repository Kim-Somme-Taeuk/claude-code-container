import { describe, expect, expectTypeOf, it } from "vitest";
import { createRequestedToolSetup } from "../../application/requested-tool-setup.js";
import type { ensureTools } from "../../container-setup.js";
import { createDefaultToolCatalog, type ToolDefinition } from "../../domain/tool-registry.js";
import type { RequestedToolSetupPorts } from "../../ports/requested-tool-setup.js";

// Compile-only checks stay uncalled, including all references to the native facade.
function compileContracts(ports: RequestedToolSetupPorts, tool: ToolDefinition, facade: typeof ensureTools) {
    const app = createRequestedToolSetup(ports);
    expectTypeOf<Parameters<typeof createRequestedToolSetup>>().toEqualTypeOf<[ports: RequestedToolSetupPorts]>();
    expectTypeOf<keyof RequestedToolSetupPorts>().toEqualTypeOf<"ensureClaudeLauncher" | "ensureNpmTool" | "probeLauncher" | "ensureCodexSandbox">();
    expectTypeOf<Parameters<typeof ports.ensureClaudeLauncher>>().toEqualTypeOf<[target: string]>();
    expectTypeOf<Parameters<typeof ports.ensureNpmTool>>().toEqualTypeOf<[target: string, originalTool: ToolDefinition]>();
    expectTypeOf<Parameters<typeof ports.probeLauncher>>().toEqualTypeOf<[target: string, path: string]>();
    expectTypeOf<Parameters<typeof ports.ensureCodexSandbox>>().toEqualTypeOf<[target: string]>();
    expectTypeOf<ReturnType<typeof ports.ensureClaudeLauncher>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<typeof ports.ensureNpmTool>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<typeof ports.ensureCodexSandbox>>().toEqualTypeOf<void>();
    expectTypeOf<ReturnType<typeof ports.probeLauncher>>().toEqualTypeOf<{ status: number | null; error?: unknown }>();
    expectTypeOf<Parameters<typeof app.ensure>>().toEqualTypeOf<[target: string, activeTool: ToolDefinition]>();
    expectTypeOf<ReturnType<typeof app.ensure>>().toEqualTypeOf<undefined>();
    expectTypeOf<Parameters<typeof facade>>().toEqualTypeOf<[containerName: string, activeTool: ToolDefinition]>();
    expectTypeOf<ReturnType<typeof facade>>().toEqualTypeOf<void>();
    const result: undefined = app.ensure("target", tool);
    const publicResult: void = facade("target", tool);
    const status: number | null = ports.probeLauncher("target", "/launcher").status;
    const error: unknown = ports.probeLauncher("target", "/launcher").error;
    createRequestedToolSetup({ ...ports, probeLauncher: () => ({ status: null, error: Symbol("opaque") }) });

    // Void effect callbacks intentionally permit async assignment in TypeScript.
    // Trusted production composition, rather than this declaration, supplies synchronous effects.
    createRequestedToolSetup({
        ...ports,
        ensureClaudeLauncher: async () => undefined,
        ensureNpmTool: async () => undefined,
        ensureCodexSandbox: async () => undefined,
    });
    void [result, publicResult, status, error];

    // @ts-expect-error The constructor requires ports.
    createRequestedToolSetup();
    // @ts-expect-error Undefined cannot supply ports.
    createRequestedToolSetup(undefined);
    // @ts-expect-error Claude installation is required.
    createRequestedToolSetup({ ensureNpmTool: ports.ensureNpmTool, probeLauncher: ports.probeLauncher, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error npm installation is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, probeLauncher: ports.probeLauncher, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error Launcher observation is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, ensureNpmTool: ports.ensureNpmTool, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error The Codex sandbox postcondition is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, ensureNpmTool: ports.ensureNpmTool, probeLauncher: ports.probeLauncher });
    // @ts-expect-error Claude installation must be callable.
    createRequestedToolSetup({ ...ports, ensureClaudeLauncher: true });
    // @ts-expect-error npm installation must be callable.
    createRequestedToolSetup({ ...ports, ensureNpmTool: tool });
    // @ts-expect-error Launcher observation must be callable.
    createRequestedToolSetup({ ...ports, probeLauncher: { status: 0 } });
    // @ts-expect-error The Codex sandbox postcondition must be callable.
    createRequestedToolSetup({ ...ports, ensureCodexSandbox: undefined });
    // @ts-expect-error Launcher observations must be synchronous.
    createRequestedToolSetup({ ...ports, probeLauncher: async () => ({ status: 0 }) });
    // @ts-expect-error A launcher observation requires status.
    createRequestedToolSetup({ ...ports, probeLauncher: () => ({ error: undefined }) });
    // @ts-expect-error Status cannot be a string.
    createRequestedToolSetup({ ...ports, probeLauncher: () => ({ status: "0" }) });
    // @ts-expect-error Status cannot be undefined in the declared probe contract.
    createRequestedToolSetup({ ...ports, probeLauncher: () => ({ status: undefined }) });
    // @ts-expect-error Void is not a launcher observation.
    createRequestedToolSetup({ ...ports, probeLauncher: (): void => {} });
    // @ts-expect-error Ensure requires both target and descriptor.
    app.ensure("target");
    // @ts-expect-error Ensure requires a string target.
    app.ensure(1, tool);
    // @ts-expect-error A name alone is not the canonical tool descriptor.
    app.ensure("target", { name: "codex" });
    // @ts-expect-error npm installation requires the canonical descriptor.
    ports.ensureNpmTool("target", "codex");
    // @ts-expect-error Claude installation requires a string target.
    ports.ensureClaudeLauncher(1);
    // @ts-expect-error Launcher observation requires a path.
    ports.probeLauncher("target");
    // @ts-expect-error Launcher paths must be strings.
    ports.probeLauncher("target", 1);
    // @ts-expect-error The sandbox postcondition requires a target.
    ports.ensureCodexSandbox();
    // @ts-expect-error The facade requires a descriptor.
    facade("target");
    // @ts-expect-error The facade target remains a string.
    facade(1, tool);
    // @ts-expect-error The facade accepts the canonical descriptor.
    facade("target", "codex");
    // @ts-expect-error Application completion is synchronous.
    const promise: Promise<undefined> = app.ensure("target", tool);
    // @ts-expect-error Application completion is not a success flag.
    const success: boolean = app.ensure("target", tool);
    // @ts-expect-error The public facade retains its legacy void return.
    const strictPublicResult: undefined = facade("target", tool);
    // @ts-expect-error Opaque probe errors cannot be treated as a structured error without narrowing.
    const structuredError: { code: string } = ports.probeLauncher("target", "/launcher").error;
    void [promise, success, strictPublicResult, structuredError];
}
void compileContracts;

describe("requested tool setup compile contracts", () => {
    it("returns undefined through the synchronous application API", () => {
        const app = createRequestedToolSetup({
            ensureClaudeLauncher: () => undefined,
            ensureNpmTool: () => undefined,
            probeLauncher: () => ({ status: 0 }),
            ensureCodexSandbox: () => undefined,
        });
        expect(app.ensure("target", createDefaultToolCatalog()[0]!)).toBeUndefined();
    });
});
