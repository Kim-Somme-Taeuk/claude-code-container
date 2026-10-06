import type { ToolDefinition } from "../domain/tool-registry.js";

export interface RequestedToolSetupPorts {
    ensureClaudeLauncher(target: string): void;
    ensureNpmTool(target: string, originalTool: ToolDefinition): void;
    probeLauncher(target: string, path: string): { status: number | null; error?: unknown };
    ensureCodexSandbox(target: string): void;
}
