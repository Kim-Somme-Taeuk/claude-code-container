import { compactToolResult } from "./public-output.mjs";
import { isSimpleAction, TOOLS, publicToolName, GROUP_OPERATIONS } from "./tools.mjs";
import { jsonResult, MCP_ERROR_TEXT_LIMIT_BYTES, truncateDiagnosticText } from "@ccc/device-lab/providers/responses.mjs";
const publicNames = new Set(TOOLS.map(({ name }) => name));

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const evidenceKeys = ["error", "code", "cause", "detail", "reason", "policy", "remedy", "remedies", "recovery", "warning", "warnings", "cleanup", "containment", "scrubContainmentFailed", "diagnosticTruncated", "applied"];
const envelopes = ["result", "response", "body", "value", "broker"];

function boundKnownFailure(result, boundWarnings = false) {
    if (!result.isError && !boundWarnings) return result;
    let changed = false;
    const content = result.content.map(item => {
        if (item.type !== "text" || Buffer.byteLength(item.text, "utf8") <= MCP_ERROR_TEXT_LIMIT_BYTES) return item;
        try {
            const value = JSON.parse(item.text);
            if (!object(value)) return item;
            changed = true;
            // Preserve separately budgeted recovery fields, then use remaining
            // space for command diagnostics omitted by the generic error summary.
            const bounded = JSON.parse(jsonResult({ ...value, ok: false }).content[0].text);
            if (typeof value.ok === "boolean") bounded.ok = value.ok;
            else delete bounded.ok;
            if (typeof value.error !== "string" && bounded.error === "diagnostic-response-too-large") delete bounded.error;
            const remaining = MCP_ERROR_TEXT_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(bounded), "utf8") - 128;
            if (remaining > 128) bounded.diagnosticExcerpt = truncateDiagnosticText(item.text,
                Math.min(Math.floor(MCP_ERROR_TEXT_LIMIT_BYTES / 4), Math.floor(remaining / 2)));
            return { ...item, text: JSON.stringify(bounded) };
        } catch { return item; }
    });
    return changed ? { ...result, content } : result;
}

// Inspect only known protocol envelopes, never arbitrary exec output or UI data.
function actionEvidence(value, operation, forcedFailure = false) {
    if (!object(value)) return { failed: false, evidence: {} };
    let failed = forcedFailure || value.ok === false || value.isError === true || Boolean(value.error)
        || (typeof value.status === "number" && value.status !== 0 && value.status !== 200 && value.status !== 201 && value.status !== 204);
    const evidence = {};
    for (const key of evidenceKeys) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== ""
            && !(Array.isArray(value[key]) && value[key].length === 0)) evidence[key] = value[key];
    }
    if (typeof value.stderr === "string" && value.stderr.trim()) evidence.warning = value.stderr;
    if (failed && typeof value.stdout === "string" && value.stdout.trim()) evidence.stdout = value.stdout;
    if (failed && value.status !== undefined) evidence.status = value.status;
    if (operation === "mobile_set_battery" && Array.isArray(value.results)) {
        const diagnostics = value.results.flatMap((entry, index) => {
            const observed = actionEvidence(entry, undefined, forcedFailure);
            failed ||= observed.failed;
            const diagnostic = { ...observed.evidence };
            if (typeof entry?.stdout === "string" && entry.stdout.trim()) diagnostic.stdout = entry.stdout;
            return Object.keys(diagnostic).length ? [{ index, ...diagnostic }] : [];
        });
        if (diagnostics.length) evidence.results = diagnostics;
    }
    for (const key of envelopes) {
        const nested = actionEvidence(value[key], operation, forcedFailure);
        failed ||= nested.failed;
        if (Object.keys(nested.evidence).length) evidence[key] = nested.evidence;
    }
    return { failed, evidence };
}

function publicIdentities(value) {
    if (!object(value)) return value;
    const result = { ...value };
    if (Array.isArray(result.capabilities)) {
        const supportedActions = { ...result.supportedActions };
        for (const [name, actions] of Object.entries(GROUP_OPERATIONS)) {
            const supported = Object.entries(actions).filter(([, operation]) => result.capabilities.includes(operation)).map(([action]) => action);
            if (supported.length) supportedActions[name] = supported;
        }
        if (Object.keys(supportedActions).length) result.supportedActions = supportedActions;
        result.capabilities = [...new Set(result.capabilities.map(name => publicToolName(name, typeof result.backend === "string" ? result.backend : result.name)).filter((name) => publicNames.has(name)))];
        if (result.capabilities.includes("cursor_position")
            && (result.backend === "x11" || result.name === "x11-current-display" || result.kind === "display" || (["windows-vm", "linux-vm"].includes(result.name || result.backend) && result.provider === "hyper-v"))) result.capabilities.push("move");
    }
    for (const key of ["device", "target", "backend"]) if (object(result[key])) result[key] = publicIdentities(result[key]);
    for (const key of ["devices", "backends", "localBackends", "targets"]) if (Array.isArray(result[key])) result[key] = result[key].map(publicIdentities);
    return result;
}

// Translate only operation-owned protocol fields. Guest commands and UI payloads
// are opaque and must retain application-supplied keys and text.
const APP_RESULTS = new Set(["install_app", "launch_app", "stop_app", "uninstall_app", "clear_app_data", "wait_for_app", "permission", "upload", "download", "list_files"]);
function publicOperationValue(name, value, compact = false) {
    if (!object(value) || ["exec", "ui"].includes(name)) return value;
    const result = { ...value };
    if (APP_RESULTS.has(name)) {
        const appId = result.appId ?? result.packageName ?? result.bundleId;
        if (typeof appId === "string") {
            result.appId = appId;
            if (result.packageName === appId) delete result.packageName;
            if (result.bundleId === appId) delete result.bundleId;
        }
    }
    if (["wait_for_text", "wait_for_app"].includes(name) && !actionEvidence(value).failed) {
        const matched = typeof result.matched === "boolean" ? result.matched
            : typeof result.found === "boolean" ? result.found : name === "wait_for_app" ? result.running : undefined;
        if (typeof matched === "boolean") {
            result.matched = matched;
            if (!matched) result.reason ??= "wait-condition-not-met";
            if (compact) {
                delete result.found;
                delete result.running;
                delete result.nativeStatus;
            }
        }
    }
    if (name === "wireless") {
        if (object(result.attachNext) && typeof result.attachNext.tool === "string") {
            result.attachNext = { ...result.attachNext, tool: publicToolName(result.attachNext.tool) };
        }
        const translate = text => text.replace(/device_inventory for backend ([a-z-]+)/g, 'devices({view:"available",backend:"$1"})')
            .replace(/\bdevice_inventory\b/g, 'devices with view:"available"')
            .replace(/\bdevice_attach\b/g, "attach");
        for (const key of ["attachFlow", "note"]) if (typeof result[key] === "string") result[key] = translate(result[key]);
        if (Array.isArray(result.notes)) result.notes = result.notes.map(note => typeof note === "string" ? translate(note) : note);
    }
    for (const key of ["result", "response", "body", "broker"]) {
        if (object(result[key])) result[key] = publicOperationValue(name, result[key], compact);
    }
    const appRecord = { permission: "permission", clear_app_data: "reset", wait_for_app: "activeApp", upload: "uploaded", download: "downloaded" }[name];
    if (appRecord && object(result[appRecord])) result[appRecord] = publicOperationValue(name, result[appRecord], compact);
    return result;
}

function queryValue(name, value, operation) {
    if (!object(value) || value.ok === false || value.error) return value;
    const result = ["exec", "ui"].includes(name) ? value : publicIdentities(value);
    delete result.ok;
    if (name === "devices" && operation === "device_list" && Array.isArray(result.devices)) {
        return result.devices.map((device) => {
            if (!object(device)) return device;
            const entry = {};
            for (const key of ["id", "name", "backend", "provider", "platform", "state", "available", "incarnationId", "capabilities", "supportedActions", "error", "warnings"]) {
                if (device[key] !== undefined) entry[key] = device[key];
            }
            entry.state ??= device.runtimeState ?? device.status ?? device.targetStatus?.runtimeState ?? "unknown";
            const readiness = device.readiness ?? device.targetStatus?.readiness;
            const lease = device.leaseState ?? device.targetStatus?.leaseState;
            if (readiness && !["ready", "stopped"].includes(readiness.state)) entry.readiness = readiness;
            if (lease && !["owned", "not-required"].includes(lease.state)) entry.lease = lease;
            return entry;
        });
    }
    if (name === "cursor_position") {
        const cursor = object(result.cursor) ? result.cursor : result;
        const observed = actionEvidence(result);
        if (!observed.failed && typeof cursor.x === "number" && typeof cursor.y === "number") {
            return { x: cursor.x, y: cursor.y, ...observed.evidence };
        }
    }
    return result;
}

export function actionResult(name, operation, raw, { detail = false } = {}) {
    if (detail) {
        if (!Array.isArray(raw?.content)) return raw;
        const content = raw.content.map((item) => {
            if (item.type !== "text") return item;
            try {
                const value = JSON.parse(item.text);
                const visible = publicOperationValue(name, ["exec", "ui"].includes(name) ? value : publicIdentities(value));
                return JSON.stringify(value) === JSON.stringify(visible) ? item : { ...item, text: JSON.stringify(visible) };
            } catch { return item; }
        });
        const failed = isSimpleAction(name, operation) || ["wait_for_text", "wait_for_app"].includes(name)
            ? raw.content.some(item => { try { return item.type === "text" && actionEvidence(JSON.parse(item.text), operation).failed; } catch { return false; } }) : false;
        const result = !failed && content.every((item, index) => item === raw.content[index]) ? raw : { ...raw, content, ...(failed ? { isError: true } : {}) };
        return isSimpleAction(name, operation) || ["wait_for_text", "wait_for_app"].includes(name) ? boundKnownFailure(result) : result;
    }
    const result = compactToolResult(operation, raw);
    if (!Array.isArray(result?.content)) return result;
    let isError = Boolean(result.isError);
    // Do not allow presentation to hide a provider failure inside an envelope.
    if (isSimpleAction(name, operation) || ["wait_for_text", "wait_for_app"].includes(name)) {
        for (const item of raw.content || []) {
            if (item.type !== "text") continue;
            try { isError ||= actionEvidence(JSON.parse(item.text), operation).failed; } catch { /* Plain text has the MCP error flag. */ }
        }
    }
    const content = [];
    for (const item of result.content) {
        if (item.type !== "text") { content.push(item); continue; }
        let value;
        try { value = JSON.parse(item.text); } catch {
            if (isError) {
                const bounded = JSON.parse(jsonResult({ ok: false, error: item.text }).content[0].text);
                delete bounded.ok;
                content.push({ ...item, text: JSON.stringify(bounded) });
            } else content.push(item);
            continue;
        }
        isError ||= object(value) && (value.ok === false || Boolean(value.error));
        if (isSimpleAction(name, operation)) {
            const observed = actionEvidence(value, operation, isError);
            isError ||= observed.failed;
            if (Object.keys(observed.evidence).length) content.push({ ...item, text: JSON.stringify(observed.evidence) });
            else if (isError) content.push({ ...item, text: JSON.stringify({ error: "Action failed" }) });
        } else content.push({ ...item, text: JSON.stringify(publicOperationValue(name, queryValue(name, value, operation), true)) });
    }
    if (!content.length && !isError && isSimpleAction(name, operation)) content.push({ type: "text", text: "ok" });
    const presented = { ...result, content, ...(isError ? { isError: true } : {}) };
    return isSimpleAction(name, operation) || ["wait_for_text", "wait_for_app"].includes(name) ? boundKnownFailure(presented, isSimpleAction(name, operation)) : presented;
}
