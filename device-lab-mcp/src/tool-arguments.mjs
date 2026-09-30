import { TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS } from "./tools.mjs";

const DEVICE_TARGET_PROPERTIES = new Map(TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => [tool.name, tool.inputSchema.properties]));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Check the external shape before supplying internal provider defaults.
export function toolInputError(name, args = {}) {
    if (!TOOL_NAMES.has(name)) return `Unknown tool: ${name}`;
    if (!args || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be an object";
    if (Object.hasOwn(args, "options")) return "Use flat tool arguments; options is not supported";
    if (Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, name) && Object.hasOwn(args, "backend")) {
        return `${name} selects its backend automatically; omit backend`;
    }
    return null;
}

export function normalizeToolArgs(args = {}, toolName) {
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    const { detail: _detail, ...normalized } = args;
    if (normalized.backend === undefined && Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, toolName)) {
        normalized.backend = SINGLE_BACKEND_TOOL_DEFAULTS[toolName];
    }
    return normalized;
}

// The runtime and real-provider verifier must interpret shared targets identically.
export function flowStepArguments(tool, rawFlowArgs, rawStepArgs) {
    const args = normalizeToolArgs(rawFlowArgs);
    const stepArgs = normalizeToolArgs(rawStepArgs);
    const sharedTarget = {};
    const changedTarget = ["deviceId", "backend"].some((key) =>
        Object.hasOwn(args, key) && Object.hasOwn(stepArgs, key) && args[key] !== stepArgs[key]);
    if (DEVICE_TARGET_PROPERTIES.has(tool) && !changedTarget) {
        for (const key of ["deviceId", "backend", "incarnationId"]) {
            if (Object.hasOwn(args, key) && Object.hasOwn(DEVICE_TARGET_PROPERTIES.get(tool), key)) sharedTarget[key] = args[key];
        }
    }
    return { ...sharedTarget, ...stepArgs };
}
