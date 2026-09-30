import { validateListFilesArgs } from "./file-listing.mjs";
import { createInputError, normalizeCreateArgs } from "./creation-input.mjs";
import { TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS, GROUP_OPERATIONS, toolOperation } from "./tools.mjs";
import { SINGLE_BACKEND_TOOL_DEFAULTS as OPERATION_DEFAULTS } from "./operation-tools.mjs";

const DEVICE_TARGET_PROPERTIES = new Map(TOOLS
    .filter((tool) => tool.inputSchema?.required?.includes("deviceId"))
    .map((tool) => [tool.name, tool.inputSchema.properties]));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Check the external shape before supplying internal provider defaults.
export function toolInputError(name, args = {}) {
    if (!TOOL_NAMES.has(name)) return `Unknown tool: ${name}`;
    if (!args || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be an object";
    if (Object.hasOwn(args, "helperTimeoutMs")) return "Use timeoutMs; helperTimeoutMs is an internal option";
    const timeout = TOOLS.find(tool => tool.name === name)?.inputSchema.properties.timeoutMs;
    if (timeout && args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs < timeout.minimum || args.timeoutMs > timeout.maximum)) return `timeoutMs must be between ${timeout.minimum} and ${timeout.maximum}`;
    if (name === "reset" && ["packageName", "bundleId", "containerType", "eraseSimulator"].some(key => Object.hasOwn(args, key))) return "reset erases an iOS Simulator; use clear_app_data for an app";
    if (Object.hasOwn(args, "options")) return "Use flat tool arguments; options is not supported";
    if (name === "create") {
        const error = createInputError(args);
        if (error) return error;
        if (args.dryRun === true && args.backend === "linux-vm" && args.provider !== "hyper-v") return "create dryRun on Linux requires provider:hyper-v; container QEMU does not support dryRun";
        return null;
    }
    if ((DEVICE_TARGET_PROPERTIES.has(name) || name === "run_flow") && Object.hasOwn(args, "backend")) {
        return "deviceId determines the backend; omit backend";
    }
    if (Object.hasOwn(GROUP_OPERATIONS, name) && !toolOperation(name, args)) return `${name} requires action: ${Object.keys(GROUP_OPERATIONS[name]).join(", ")}`;
    if (name === "snapshot") {
        if (args.action === "create" && !(typeof args.snapshotName === "string" && args.snapshotName.trim())) return "snapshot create requires snapshotName";
        if (["restore", "delete"].includes(args.action) && ![args.snapshotName, args.snapshotId].some((value) => typeof value === "string" && value.trim())) return `snapshot ${args.action} requires snapshotName or snapshotId`;
    }
    if (name === "permission" && ![[args.packageName, args.permission], [args.bundleId, args.service]].some((pair) => pair.every((value) => typeof value === "string" && value.trim()))) return "permission requires packageName and permission, or bundleId and service";
    if (name === "clipboard" && Object.hasOwn(args, "text") && typeof args.text !== "string") return "clipboard text must be a string";
    if (name === "list_files") return validateListFilesArgs(args);
    if (name === "key" && !(typeof args.key === "string" && args.key.length > 0)
        && !(Number.isInteger(args.keyCode) && args.keyCode >= 0)) return "key requires key or keyCode";
    if (name === "move" && (!Number.isInteger(args.x) || args.x < 0 || !Number.isInteger(args.y) || args.y < 0)) return "move requires nonnegative integer x and y";
    if (name === "cursor_position" && (Object.hasOwn(args, "x") || Object.hasOwn(args, "y"))) return "Use move to change cursor position";
    if (Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, name) && Object.hasOwn(args, "backend")) {
        return `${name} selects its backend automatically; omit backend`;
    }
    return null;
}

// Public translation happens once; provider/internal calls retain their own contract.
export function normalizePublicToolArgs(name, args = {}) {
    const normalized = normalizeToolArgs(args, toolOperation(name, args));
    if (name === "create") return normalizeCreateArgs(normalized);
    if (name === "reset") normalized.eraseSimulator = true;
    const schema = TOOLS.find(tool => tool.name === name)?.inputSchema;
    if (schema?.properties.timeoutMs && args.timeoutMs !== undefined
        && !["wait_for_text", "wait_for_app", "wireless"].includes(name)) {
        normalized.helperTimeoutMs = Math.min(Number(args.timeoutMs), 300000);
        normalized.rpcTimeoutMs ??= Math.min(Number(args.timeoutMs) + 30000, 630000);
    }
    return normalized;
}

export function normalizeToolArgs(args = {}, toolName) {
    if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
    const { detail: _detail, ...normalized } = args;
    if (Object.values(GROUP_OPERATIONS).some((group) => Object.values(group).includes(toolName))) delete normalized.action;
    if (normalized.backend === undefined && Object.hasOwn(OPERATION_DEFAULTS, toolName)) {
        normalized.backend = OPERATION_DEFAULTS[toolName];
    }
    return normalized;
}

// The runtime and real-provider verifier must interpret shared targets identically.
export function flowStepArguments(tool, rawFlowArgs, rawStepArgs) {
    const args = normalizeToolArgs(rawFlowArgs);
    const stepArgs = { ...normalizeToolArgs(rawStepArgs), ...(Object.hasOwn(rawStepArgs || {}, "action") ? { action: rawStepArgs.action } : {}) };
    const sharedTarget = {};
    const changedTarget = ["deviceId"].some((key) =>
        Object.hasOwn(args, key) && Object.hasOwn(stepArgs, key) && args[key] !== stepArgs[key]);
    if (DEVICE_TARGET_PROPERTIES.has(tool) && !changedTarget) {
        for (const key of ["deviceId", "incarnationId"]) {
            if (Object.hasOwn(args, key) && Object.hasOwn(DEVICE_TARGET_PROPERTIES.get(tool), key)) sharedTarget[key] = args[key];
        }
    }
    return { ...sharedTarget, ...stepArgs };
}
