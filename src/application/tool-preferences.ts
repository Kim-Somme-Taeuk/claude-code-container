import type { ToolDefinition } from "../domain/tool-registry.js";
import type { ToolPreferencePorts } from "../ports/tool-preferences.js";

export interface ToolPreferences {
    getDefaultToolPreference(): string | null;
    setDefaultToolPreference(toolName: string): void;
    resolveTool(): ToolDefinition;
}

export function createToolPreferences(ports: ToolPreferencePorts): ToolPreferences {
    for (const name of ["readToolOverride", "readSavedDefaultTool", "saveDefaultTool", "findTool", "getDefaultTool"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Tool preferences requires a callable ${name} port.`);
        }
    }

    function getDefaultToolPreference(): string | null {
        const value = ports.readSavedDefaultTool();
        return typeof value === "string" ? value : null;
    }

    return {
        getDefaultToolPreference,

        setDefaultToolPreference(toolName) {
            ports.saveDefaultTool(toolName);
        },

        // Layer 1: explicit override; Layer 2: saved preference, read only
        // after an override miss; Layer 3: default tool.
        resolveTool() {
            const override = ports.readToolOverride();
            if (override) {
                const tool = ports.findTool(override);
                if (tool) return tool;
            }

            const savedPref = getDefaultToolPreference();
            if (savedPref) {
                const tool = ports.findTool(savedPref);
                if (tool) return tool;
            }

            return ports.getDefaultTool();
        },
    };
}
