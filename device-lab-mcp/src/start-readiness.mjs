import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function helperEvidence(value) {
    if (!object(value)) return undefined;
    const evidence = {};
    if (["sandbox-id-invalid", "prerequisites-missing", "session-connect-failed", "response-rejected", "response-timeout"].includes(value.stage)) evidence.stage = value.stage;
    if (["login-unavailable", "timeout", "command-failed"].includes(value.bootstrapFailure)) evidence.bootstrapFailure = value.bootstrapFailure;
    for (const key of ["bootstrapDeadlineExhausted", "readyMarkerPresent", "bootstrapAttempted", "bootstrapOk", "requestAttempted", "requestOk", "responseParseFailed"]) {
        if (typeof value[key] === "boolean") evidence[key] = value[key];
    }
    if (Number.isInteger(value.guestStatus) && value.guestStatus >= -2147483648 && value.guestStatus <= 2147483647) evidence.guestStatus = value.guestStatus;
    if (object(value.logEvidence)) {
        const logs = {};
        for (const key of ["bootstrapStarted", "bootstrapReady", "helperHeartbeat"]) {
            if (typeof value.logEvidence[key] === "boolean") logs[key] = value.logEvidence[key];
        }
        for (const key of ["bootstrapStderr", "helperStderr"]) {
            if (["absent", "empty", "access-denied", "path-not-found", "script-policy", "parse-error", "other-error", "unreadable", "oversized"].includes(value.logEvidence[key])) logs[key] = value.logEvidence[key];
        }
        if (Object.keys(logs).length) evidence.logEvidence = logs;
    }
    return Object.keys(evidence).length ? evidence : undefined;
}

// Traverse only protocol envelopes, never arbitrary guest output.
function observations(result) {
    const values = [];
    const visit = (value, depth = 0) => {
        if (!object(value) || depth > 8) return;
        values.push(value);
        for (const key of ["result", "body", "response", "selected", "device", "boot", "lastBootCheck"]) visit(value[key], depth + 1);
        if (Array.isArray(value.content)) for (const item of value.content) {
            if (item.type !== "text") continue;
            try { visit(JSON.parse(item.text), depth + 1); } catch { /* plain acknowledgments */ }
        }
    };
    visit(result);
    return values;
}

export function startBootTimeoutMs(args, backend = args?.backend) {
    return Number.isFinite(args?.bootTimeoutMs)
        ? Math.min(600000, Math.max(1000, args.bootTimeoutMs))
        : backend === "macos-vm" ? 300000 : 60000;
}

export async function finishStartReadiness(result, args, startedAt, invoke, {
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    if (args.waitForBoot === false) return result;
    const values = observations(result);
    if (values.some(value => value.isError === true || value.ok === false || value.error)) {
        return result.isError === true ? result : { ...result, isError: true };
    }
    const device = values.find(value => (value.id === args.deviceId || value.deviceId === args.deviceId) && typeof value.backend === "string");
    const backend = device?.backend ?? args.backend;
    const failure = (detail, readiness) => jsonResult({ ok: false, error: "device-start-not-ready", deviceId: args.deviceId, detail, ...(readiness ? { readiness } : {}) });
    if (!backend) return failure("missing-start-backend");
    if (values.some(value => (value.bootReady === false && value.lastBootCheck?.skipped !== true)
        || (value.ready === false && value.skipped !== true))) {
        return failure("boot-readiness-failed");
    }
    if (!["macos-vm", "windows-sandbox"].includes(backend)) return result;
    const deadline = startedAt + startBootTimeoutMs(args, backend);
    let readiness = { attempts: 0, lastProbe: "not-attempted" };
    while (now() < deadline) {
        const remaining = deadline - now();
        const timeoutMs = Math.min(10000, remaining);
        let probe;
        let transportException = false;
        const attempts = readiness.attempts + 1;
        try { probe = await invoke("device_cursor_position", {
            ...Object.fromEntries(["broker", "viaBroker", "implicitBroker", "host", "port", "hostCandidates", "autolaunch", "brokerProbeTimeoutMs"]
                .filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])),
            deviceId: args.deviceId,
            backend,
            ...(args.incarnationId ? { incarnationId: args.incarnationId } : {}),
            helperTimeoutMs: timeoutMs,
            rpcTimeoutMs: remaining,
        }); } catch {
            // Transport exceptions do not establish readiness. Retry only within
            // the original start deadline and never expose raw command output.
            probe = null;
            transportException = true;
        }
        const observed = observations(probe);
        const failed = observed.some(value => value.isError === true || value.ok === false || value.error);
        if (now() <= deadline && !failed && observed.some(value => object(value.cursor) && Number.isFinite(value.cursor.x) && Number.isFinite(value.cursor.y))) return result;
        const currentHelper = observed.map(value => helperEvidence(value.helperDiagnostic)).find(Boolean);
        const helper = currentHelper || readiness.helper;
        const helperAttempt = currentHelper ? attempts : readiness.helperAttempt;
        readiness = { attempts, lastProbe: transportException ? "transport-exception" : failed ? "provider-error"
            : now() > deadline ? "late-response" : "missing-cursor", ...(helper ? { helper, helperAttempt } : {}) };
        if (now() >= deadline) break;
        await sleep(Math.min(500, deadline - now()));
    }
    return failure("control-transport-timeout", readiness);
}
