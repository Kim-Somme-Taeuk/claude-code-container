// src/tool-detect.ts - Tool preference detection and resolution
//
// Resolves which AI coding tool to use via layered precedence:
//   Layer 1: CCC_TOOL environment variable
//   Layer 2: Saved preference in ~/.ccc/config.json
//   Layer 3: Default tool (claude)
// Preference policy lives in the application layer; this facade wires the
// native config file and the process-local tool catalog.

import { getDefaultTool, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { readCccConfig, updateCccConfig } from "./home-layout.js";
import { createToolPreferences } from "./application/tool-preferences.js";

function toolPreferences(readToolOverride: () => string | undefined = () => undefined) {
    return createToolPreferences({
        readToolOverride,
        readSavedDefaultTool: () => readCccConfig()["defaultTool"],
        saveDefaultTool: (toolName) => updateCccConfig((config) => {
            config.defaultTool = toolName;
        }),
        findTool: (name) => getToolByName(name),
        getDefaultTool: () => getDefaultTool(),
    });
}

/**
 * Read saved default tool preference from ~/.ccc/config.json
 * Returns null if not set or file cannot be read.
 */
export function getDefaultToolPreference(): string | null {
    return toolPreferences().getDefaultToolPreference();
}

/**
 * Save default tool preference to ~/.ccc/config.json.
 * Preserves existing keys; throws instead of overwriting an unparseable file.
 */
export function setDefaultToolPreference(toolName: string): void {
    toolPreferences().setDefaultToolPreference(toolName);
}

/**
 * Resolve which tool to use given the environment.
 * Layer 1: CCC_TOOL env var
 * Layer 2: Saved preference (~/.ccc/config.json)
 * Layer 3: getDefaultTool() (claude)
 */
export function resolveTool(env: Record<string, string | undefined>): ToolDefinition {
    return toolPreferences(() => env["CCC_TOOL"]).resolveTool();
}
