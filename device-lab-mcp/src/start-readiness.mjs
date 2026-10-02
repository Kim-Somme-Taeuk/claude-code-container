import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

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
    const failure = detail => jsonResult({ ok: false, error: "device-start-not-ready", deviceId: args.deviceId, detail });
    if (!backend) return failure("missing-start-backend");
    if (values.some(value => (value.bootReady === false && value.lastBootCheck?.skipped !== true)
        || (value.ready === false && value.skipped !== true))) {
        return failure("boot-readiness-failed");
    }
    if (!["macos-vm", "windows-sandbox"].includes(backend)) return result;
    const deadline = startedAt + startBootTimeoutMs(args, backend);
    while (now() < deadline) {
        const remaining = deadline - now();
        const timeoutMs = Math.min(10000, remaining);
        let probe;
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
        }
        const observed = observations(probe);
        const failed = observed.some(value => value.isError === true || value.ok === false || value.error);
        if (now() <= deadline && !failed && observed.some(value => object(value.cursor) && Number.isFinite(value.cursor.x) && Number.isFinite(value.cursor.y))) return result;
        if (now() >= deadline) break;
        await sleep(Math.min(500, deadline - now()));
    }
    return failure("control-transport-timeout");
}
