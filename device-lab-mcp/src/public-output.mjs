import { TOOLS } from "./tools.mjs";

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Presentation only: provider contracts and opaque user payloads stay untouched.
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omit(value, keys) {
    const result = { ...value };
    for (const key of keys) delete result[key];
    return result;
}

function failed(value) {
    return object(value) && (value.ok === false || value.isError === true || Boolean(value.error));
}

function internalStatus(value) {
    if (!object(value) || failed(value)) return value;
    // These objects are generated helper/session metadata, never artifact results.
    return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
        item !== null && !/^(?:ownerId|createdAt|updatedAt|serverPid|pid|serverUrl|serverPort|appiumPort|requiredFor)$/.test(key)
        && !/(?:Path|Dir|Script|Root)$/.test(key)));
}

function target(value) {
    if (!object(value) || failed(value)) return value;
    const result = omit(value, ["ownerId", "stateRoot", "ownerRoot", "stateDir", "metadataPath", "runtimeFile", "avdRoot", "createdAt", "updatedAt", "pid", "appiumPort", "capabilities"]);
    // Remove only values also represented at the target's top level.
    if (object(value.targetStatus)) {
        const remaining = Object.fromEntries(Object.entries(value.targetStatus).filter(([key, item]) => JSON.stringify(item) !== JSON.stringify(value[key])));
        if (Object.keys(remaining).length) result.targetStatus = remaining;
        else delete result.targetStatus;
    }
    for (const key of ["helper", "appium", "runtime", "sessionState"]) {
        if (object(result[key])) result[key] = internalStatus(result[key]);
    }
    if (object(result.sessionState)) {
        for (const key of ["helper", "appium"]) {
            if (object(result.sessionState[key])) result.sessionState[key] = internalStatus(result.sessionState[key]);
        }
        if (result.sessionState.state === "none" && Object.keys(result.sessionState).length === 1) delete result.sessionState;
    }
    if (result.leaseState?.state === "not-required") delete result.leaseState;
    if (result.runtimeState === result.status || result.runtimeState === result.lifecycle) delete result.runtimeState;
    for (const key of Object.keys(result)) if (result[key] === null) delete result[key];
    return result;
}

function backend(value) {
    if (!object(value)) return value;
    const result = omit(value, ["lazy", "ownerId", "stateRoot", "ownerRoot", "capabilities"]);
    if (object(result.tools)) delete result.tools;
    if (Array.isArray(result.missing) && !result.missing.length) delete result.missing;
    if (result.available === true && result.status === "available") delete result.status;
    if (result.readiness?.ok === true && result.readiness?.available === true) {
        result.readiness = omit(result.readiness, ["platform", "totalMemoryMb", "freeMemoryMb", "logicalProcessors", "qemuImgSignatureStatus"]);
        for (const key of ["ok", "available", "moduleAvailable", "hypervisorPresent", "vmmsRunning", "hyperVAdministratorsMember", "managementAccess", "qemuImgAvailable", "qemuImgTrusted"]) {
            if (result.readiness[key] === true) delete result.readiness[key];
        }
        for (const key of ["rebootPending", "sessionRefreshRequired"]) {
            if (result.readiness[key] === false) delete result.readiness[key];
        }
        for (const key of ["missing", "linuxImageMissing"]) {
            if (Array.isArray(result.readiness[key]) && result.readiness[key].length === 0) delete result.readiness[key];
        }
        if (!Object.keys(result.readiness).length) delete result.readiness;
    }
    return result;
}

function transportFailure(value) {
    const result = omit(value, ["routedBy", "ownerId", "runtime", "selected", "attempts", "launch"]);
    const same = (a, b) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
    const trace = (entry) => {
        if (!object(entry)) return entry;
        if ((entry.reason === "broker-reuse-process-verified" && entry.processVerification?.ok === true)
            || (entry.reason === "broker-owner-resolve-ready" && entry.ownerResolve?.ok === true)
            || (entry.ok === true && entry.body?.ok === true && entry.body?.name === "ccc-device-broker" && entry.endpoint?.endsWith("/health"))) return {};
        let compact = omit(entry, ["host", "port", "endpoint", "durationMs", "timeoutMs", "runtime", "ownerId", "launched", "reused"]);
        if (Array.isArray(compact.attempts) || object(compact.selected) || object(compact.launch)) compact = transportFailure(compact);
        if (same(compact.body, value.body) || same(compact.body, value.result)) delete compact.body;
        else if (object(compact.body) && same(compact.body.result, value.result)) compact.body = omit(compact.body, ["result"]);
        for (const key of ["ok", "error", "status", "detail", "remedy"]) {
            if (same(compact[key], value[key])) delete compact[key];
        }
        return compact;
    };
    if (object(value.body) && same(value.body.result, value.result)) result.body = omit(value.body, ["result"]);
    if (object(value.selected)) {
        const selected = trace(value.selected);
        if (Object.keys(selected).length) result.selected = selected;
    }
    if (object(value.launch)) {
        const launch = trace(value.launch);
        if (launch.ok === true) delete launch.ok;
        if (Object.keys(launch).length) result.launch = launch;
    }
    if (Array.isArray(value.attempts)) {
        const attempts = value.attempts.map(trace).filter((entry) =>
            !object(entry) || (Object.keys(entry).length && !same(entry, result.selected)));
        const unique = attempts.filter((entry, index) => attempts.findIndex((other) => same(entry, other)) === index);
        if (unique.length) result.attempts = unique;
    }
    return result;
}

function brokerStatus(value) {
    if (!object(value)) return value;
    const result = omit(value, ["ownerId", "lazy", "startupPolicy", "transport", "probe", "ownerResolve", "launch", "runtime", "state", "containerContract", "persistence", "implemented", "deferred", "note"]);
    const selected = value.probe?.selected;
    if (selected?.host && selected?.port) result.endpoint = `http://${selected.host}:${selected.port}`;
    for (const key of ["warnings", "remedies"]) {
        if (Array.isArray(result[key]) && result[key].length === 0) delete result[key];
    }
    // Failure details are useful even when no health endpoint was reachable.
    for (const key of ["launch", "ownerResolve"]) {
        if (failed(value[key])) result[key] = transportFailure(value[key]);
    }
    return result;
}

function project(name, value) {
    if (!object(value) || !TOOL_NAMES.has(name) || name === "device_exec") return value;
    if (name === "device_run_flow" || name === "mobile_run_flow") {
        if (!Array.isArray(value.results)) return value;
        return { ...value, results: value.results.map((step) => {
            if (!object(step) || !Array.isArray(step.content)) return step;
            return { ...step, content: step.content.map((item) => item.type === "json"
                ? { ...item, value: project(step.tool, item.value) } : item) };
        }) };
    }
    // Explicit raw transport diagnostics are opaque, including their result keys.
    if (name?.startsWith("device_broker_") && name !== "device_broker_status") return value;
    if (name === "device_broker_status") return brokerStatus(value);
    if (!name?.startsWith("device_") && !name?.startsWith("mobile_")) return value;
    // Keep complete failure and containment evidence, including nested provider errors.
    if (failed(value)) {
        const brokerFailure = typeof value.method === "string"
            && ("selected" in value || Array.isArray(value.attempts) || object(value.launch));
        return brokerFailure ? transportFailure(value) : omit(value, ["routedBy"]);
    }
    const known = "routedBy" in value || "device" in value || "devices" in value
        || "targetStatus" in value || (["device_backends", "device_inventory"].includes(name) && Array.isArray(value.backends))
        || (name === "device_status" && typeof value.id === "string")
        || (value.provider === "broker-appium" && object(value.broker));
    if (!known) return value;
    let result = omit(value, ["routedBy", "ownerId"]);
    if (name === "device_backends") {
        delete result.hostBackends;
        delete result.localBackends;
        delete result.source;
        if (Array.isArray(value.backends)) result.backends = value.backends.map(backend);
        if (object(value.broker)) result.broker = brokerStatus(value.broker);
    }
    if (object(value.device)) result.device = target(value.device);
    if (Array.isArray(value.devices)) result.devices = value.devices.map(target);
    if (object(value.targetStatus) || (name === "device_status" && typeof value.id === "string")) result = target(result);
    if (object(value.backend)) result.backend = backend(value.backend);
    if (name === "device_inventory" && object(value.discovery)) {
        result.discovery = omit(value.discovery, ["adb", "emulator", "avdmanager", "xcrun", "xcodebuild", "powershell", "ssh", "scp"]);
    }
    if (name === "device_inventory" && Array.isArray(value.backends)) {
        result.backends = value.backends.map((entry) => object(entry)
            ? { ...backend(entry), ...(Array.isArray(entry.devices) ? { devices: entry.devices.map(target) } : {}) }
            : entry);
    }
    // Known broker RPC envelope. Do not descend into exec output or arbitrary RPC values.
    if (object(value.result) && "routedBy" in value && name !== "device_exec") {
        result.result = project(name, value.result);
    }
    if (value.provider === "broker-appium" && object(value.broker) && value.broker.ok === true) {
        const response = value.broker.result?.response;
        if (!failed(value.broker.result) && !failed(response) && !failed(response?.body) && !failed(response?.body?.value) && !(response?.status >= 400)) {
            delete result.broker;
            delete result.requests;
            // Preserve unique Appium return values when no public field represents them.
            const body = response?.body;
            const payload = object(body) && "value" in body ? body.value : body;
            if (payload !== undefined && payload !== null && !["mobile_dump_ui", "mobile_get_clipboard", "mobile_wait_for_app", "mobile_wait_for_text"].includes(name)) result.value = payload;
            if (result.ok === undefined) result.ok = true;
        }
    }
    return result;
}

export function compactToolResult(name, result) {
    if (!Array.isArray(result?.content)) return result;
    return { ...result, content: result.content.map((item) => {
        if (item.type !== "text" || typeof item.text !== "string") return item;
        try {
            return { ...item, text: JSON.stringify(project(name, JSON.parse(item.text))) };
        } catch {
            return item;
        }
    }) };
}
