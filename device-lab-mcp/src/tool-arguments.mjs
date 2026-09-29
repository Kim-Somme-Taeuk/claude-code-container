import { ALL_TOOLS } from "./tools.mjs";

const DEVICE_TARGET_PROPERTIES = new Map(ALL_TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => [tool.name, tool.inputSchema.properties]));

export function normalizeToolArgs(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return {};
    const { options, detail: _detail, ...rest } = args;
    if (!options || typeof options !== "object" || Array.isArray(options)) return rest;
    const { detail: _optionDetail, ...providerOptions } = options;
    return { ...providerOptions, ...rest };
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
