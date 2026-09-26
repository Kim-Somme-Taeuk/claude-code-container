// src/tool-detect.ts - Tool preference detection and resolution
//
// Resolves which AI coding tool to use via layered precedence:
//   Layer 1: CCC_TOOL environment variable
//   Layer 2: Saved preference in ~/.ccc/config.json
//   Layer 3: Default tool (claude)

import { getDefaultTool, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { readCccConfig, updateCccConfig } from "./home-layout.js";

/**
 * Read saved default tool preference from ~/.ccc/config.json
 * Returns null if not set or file cannot be read.
 */
export function getDefaultToolPreference(): string | null {
    const value = readCccConfig()["defaultTool"];
    return typeof value === "string" ? value : null;
}

/**
 * Save default tool preference to ~/.ccc/config.json.
 * Preserves existing keys; throws instead of overwriting an unparseable file.
 */
export function setDefaultToolPreference(toolName: string): void {
    updateCccConfig((config) => {
        config.defaultTool = toolName;
    });
}

/**
 * Resolve which tool to use given the environment.
 * Layer 1: CCC_TOOL env var
 * Layer 2: Saved preference (~/.ccc/config.json)
 * Layer 3: getDefaultTool() (claude)
 */
export function resolveTool(env: Record<string, string | undefined>): ToolDefinition {
    // Layer 1: CCC_TOOL env var
    const envTool = env["CCC_TOOL"];
    if (envTool) {
        const tool = getToolByName(envTool);
        if (tool) return tool;
    }

    // Layer 2: Saved preference
    const savedPref = getDefaultToolPreference();
    if (savedPref) {
        const tool = getToolByName(savedPref);
        if (tool) return tool;
    }

    // Layer 3: Default (claude)
    return getDefaultTool();
}
