import { compactToolResult } from "./public-output.mjs";
import { isSimpleAction, TOOLS, publicToolName } from "./tools.mjs";
import { jsonResult } from "./responses.mjs";
const publicNames = new Set(TOOLS.map(({ name }) => name));

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const evidenceKeys = ["error", "code", "detail", "reason", "policy", "remedy", "remedies", "warning", "warnings", "cleanup", "containment", "scrubContainmentFailed", "diagnosticTruncated"];
const envelopes = ["result", "response", "body", "value", "broker"];

// Inspect only known protocol envelopes, never arbitrary exec output or UI data.
function actionEvidence(value) {
    if (!object(value)) return { failed: false, evidence: {} };
    let failed = value.ok === false || value.isError === true || Boolean(value.error)
        || (typeof value.status === "number" && value.status !== 0 && value.status !== 200 && value.status !== 201 && value.status !== 204);
    const evidence = {};
    for (const key of evidenceKeys) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== ""
            && !(Array.isArray(value[key]) && value[key].length === 0)) evidence[key] = value[key];
    }
    if (typeof value.stderr === "string" && value.stderr.trim()) evidence.warning = value.stderr;
    if (failed && value.status !== undefined) evidence.status = value.status;
    for (const key of envelopes) {
        const nested = actionEvidence(value[key]);
        failed ||= nested.failed;
        if (Object.keys(nested.evidence).length) evidence[key] = nested.evidence;
    }
    return { failed, evidence };
}

function publicIdentities(value) {
    if (!object(value)) return value;
    const result = { ...value };
    if (Array.isArray(result.capabilities)) {
        result.capabilities = [...new Set(result.capabilities.map(publicToolName).filter((name) => publicNames.has(name)))];
        if (result.capabilities.includes("cursor_position")
            && (result.backend === "x11" || result.name === "x11-current-display" || result.kind === "display" || (["windows-vm", "linux-vm"].includes(result.name || result.backend) && result.provider === "hyper-v"))) result.capabilities.push("move");
    }
    for (const key of ["device", "target", "backend"]) if (object(result[key])) result[key] = publicIdentities(result[key]);
    for (const key of ["devices", "backends", "localBackends", "targets"]) if (Array.isArray(result[key])) result[key] = result[key].map(publicIdentities);
    return result;
}

function queryValue(name, value) {
    if (!object(value) || value.ok === false || value.error) return value;
    const result = publicIdentities(value);
    delete result.ok;
    if (name === "list_devices" && Array.isArray(result.devices)) {
        return result.devices.map((device) => {
            if (!object(device)) return device;
            const entry = {};
            for (const key of ["id", "name", "state", "available", "incarnationId", "error", "warnings"]) {
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
                const visible = publicIdentities(value);
                return JSON.stringify(value) === JSON.stringify(visible) ? item : { ...item, text: JSON.stringify(visible) };
            } catch { return item; }
        });
        return content.every((item, index) => item === raw.content[index]) ? raw : { ...raw, content };
    }
    const result = compactToolResult(operation, raw);
    if (!Array.isArray(result?.content)) return result;
    let isError = Boolean(result.isError);
    // Do not allow presentation to hide a provider failure inside an envelope.
    if (isSimpleAction(name, operation)) {
        for (const item of raw.content || []) {
            if (item.type !== "text") continue;
            try { isError ||= actionEvidence(JSON.parse(item.text)).failed; } catch { /* Plain text has the MCP error flag. */ }
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
            const observed = actionEvidence(value);
            isError ||= observed.failed;
            if (Object.keys(observed.evidence).length) content.push({ ...item, text: JSON.stringify(observed.evidence) });
            else if (isError) content.push({ ...item, text: JSON.stringify({ error: "Action failed" }) });
        } else content.push({ ...item, text: JSON.stringify(queryValue(name, value)) });
    }
    if (!content.length && !isError && isSimpleAction(name, operation)) content.push({ type: "text", text: "ok" });
    return { ...result, content, ...(isError ? { isError: true } : {}) };
}
