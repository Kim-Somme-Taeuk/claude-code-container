import { ALL_TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS } from "./tools.mjs";

const DEVICE_TARGET_PROPERTIES = new Map(ALL_TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => [tool.name, tool.inputSchema.properties]));

export function normalizeToolArgs(args = {}, toolName) {
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    const { options, detail: _detail, ...rest } = args;
    let normalized = rest;
    if (options && typeof options === "object" && !Array.isArray(options)) {
        const { detail: _optionDetail, ...providerOptions } = options;
        normalized = { ...providerOptions, ...rest };
    }
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
