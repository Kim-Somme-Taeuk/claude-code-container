// Public tool registry with one process-local catalog.
// Pure metadata construction and selection live in the domain layer.

import {
    createDefaultToolCatalog,
    findToolByName,
    findDefaultTool,
    getAllCredentialMounts as collectCredentialMounts,
    getNpmTools as collectNpmTools,
    type CredentialMount,
    type ToolDefinition,
} from "./domain/tool-registry.js";

export type { CredentialMount, ToolDefinition } from "./domain/tool-registry.js";

const TOOLS = createDefaultToolCatalog();

export function getToolByName(name: string): ToolDefinition | undefined {
    return findToolByName(TOOLS, name);
}

export function getDefaultTool(): ToolDefinition {
    return findDefaultTool(TOOLS)!;
}

export function getAllTools(): ToolDefinition[] {
    return TOOLS;
}

export function getAllCredentialMounts(): CredentialMount[] {
    return collectCredentialMounts(TOOLS);
}

export function getNpmTools(): Array<{ cmd: string; pkg: string }> {
    return collectNpmTools(TOOLS);
}
