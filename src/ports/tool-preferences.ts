import type { ToolDefinition } from "../domain/tool-registry.js";

export interface ToolPreferencePorts {
    readToolOverride(): string | undefined;
    readSavedDefaultTool(): unknown;
    saveDefaultTool(toolName: string): void;
    findTool(name: string): ToolDefinition | undefined;
    getDefaultTool(): ToolDefinition;
}
