export const MCP_ERROR_TEXT_LIMIT_BYTES = 64 * 1024;
const MCP_ERROR_SUMMARY_STRING_LIMIT_BYTES = 4096;
const ERROR_SUMMARY_KEYS = ["ok", "error", "code", "ownerId", "method", "backend", "deviceId", "tool", "routedBy", "status"];

function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}

export function truncateDiagnosticText(value, limitBytes = MCP_ERROR_TEXT_LIMIT_BYTES) {
    const text = String(value ?? "");
    const requestedLimit = Number(limitBytes);
    const boundedLimit = Number.isFinite(requestedLimit) ? Math.max(0, Math.trunc(requestedLimit)) : MCP_ERROR_TEXT_LIMIT_BYTES;
    const originalBytes = utf8Bytes(text);
    if (originalBytes <= boundedLimit) return text;
    const suffix = `\n...[diagnostic truncated: ${originalBytes} bytes, limit ${boundedLimit} bytes]`;
    if (utf8Bytes(suffix) >= boundedLimit) return Buffer.from(suffix, "utf8").subarray(0, boundedLimit).toString("utf8");
    const prefixBudget = boundedLimit - utf8Bytes(suffix);
    let prefix = Buffer.from(text, "utf8").subarray(0, prefixBudget).toString("utf8");
    while (prefix && utf8Bytes(prefix) > prefixBudget) prefix = prefix.slice(0, -1);
    return `${prefix}${suffix}`;
}

function isFailureDiagnostic(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        && (value.ok === false || typeof value.error === "string");
}

function oversizedDiagnosticSummary(value, originalBytes) {
    const summary = {};
    for (const key of ERROR_SUMMARY_KEYS) {
        const item = value[key];
        if (item === null || typeof item === "boolean" || typeof item === "number") summary[key] = item;
        else if (typeof item === "string") summary[key] = truncateDiagnosticText(item, MCP_ERROR_SUMMARY_STRING_LIMIT_BYTES);
    }
    if (summary.ok === undefined) summary.ok = false;
    if (typeof summary.error !== "string") summary.error = "diagnostic-response-too-large";
    return {
        ...summary,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES,
    };
}

export function textResult(ok, text) {
    return { content: [{ type: "text", text: ok ? text : truncateDiagnosticText(text) }], isError: !ok };
}

export function jsonResult(value) {
    let text = JSON.stringify(value, null, 2);
    if (isFailureDiagnostic(value)) {
        const originalBytes = utf8Bytes(text);
        if (originalBytes > MCP_ERROR_TEXT_LIMIT_BYTES) text = JSON.stringify(oversizedDiagnosticSummary(value, originalBytes), null, 2);
    }
    return textResult(true, text);
}

// Only flow envelopes use this bound: preserve step outcomes before spending
// the remaining bytes on diagnostics. Standalone opaque tool results are unchanged.
export function flowJsonResult(value, { detail = false } = {}) {
    let serialize = (item) => JSON.stringify(item, null, detail ? 2 : undefined);
    let text = serialize(value);
    if (value.ok !== false || utf8Bytes(text) <= MCP_ERROR_TEXT_LIMIT_BYTES) return textResult(true, text);
    const originalBytes = utf8Bytes(text);
    serialize = (item) => JSON.stringify(item);
    const marker = (item) => ({ diagnosticTruncated: true, originalBytes: utf8Bytes(JSON.stringify(item)) });
    const summary = {
        ...value,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES,
        results: value.results.map((step) => ({
            ...step,
            ...(Array.isArray(step.content) ? { content: step.content.map((item) =>
                !step.isError && (item.type === "json" || item.type === "text")
                    ? { type: item.type, ...marker(item), omitted: true }
                    : item) } : {}),
        })),
    };
    text = serialize(summary);
    if (utf8Bytes(text) <= MCP_ERROR_TEXT_LIMIT_BYTES) return textResult(true, text);

    // Put actionable evidence ahead of bulky observations if a pathological
    // diagnostic must ultimately become a bounded JSON excerpt.
    const evidenceKeys = ["ok", "code", "error", "cause", "reason", "remedy", "remedies", "recovery", "cleanup", "containment", "scrubContainmentFailed", "detail", "result", "body"];
    const diagnostic = (item, limit) => JSON.stringify(item, (_key, entry) => {
        if (typeof entry === "string") return truncateDiagnosticText(entry, limit);
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const keys = Object.keys(entry);
            return Object.fromEntries([
                ...evidenceKeys.filter((key) => keys.includes(key)),
                ...keys.filter((key) => !evidenceKeys.includes(key)),
            ].map((key) => [key, entry[key]]));
        }
        return entry;
    });
    // Budget the actual serialized representation, including JSON escaping and
    // indentation. Binary search also handles multibyte labels and diagnostics.
    const excerpt = (input, budget) => {
        let low = 0;
        let high = utf8Bytes(input);
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (utf8Bytes(serialize(truncateDiagnosticText(input, middle))) <= budget) low = middle;
            else high = middle - 1;
        }
        return truncateDiagnosticText(input, low);
    };
    // Each step gets a fair budget, so 50 failures cannot evict the last cause.
    const envelopeBytes = utf8Bytes(serialize({ ...summary, results: [] }));
    const stepBudget = Math.floor((MCP_ERROR_TEXT_LIMIT_BYTES - envelopeBytes - 512) / summary.results.length);
    summary.results = summary.results.map((step) => {
        const bounded = { ...step };
        for (const key of ["label", "tool", "error"]) {
            if (typeof bounded[key] !== "string") continue;
            const shortened = excerpt(bounded[key], Math.min(512, Math.floor(stepBudget / 8)));
            if (shortened !== bounded[key]) {
                bounded[`${key}Truncated`] = { originalBytes: utf8Bytes(bounded[key]) };
                bounded[key] = shortened;
            }
        }
        if (!Array.isArray(step.content)) return bounded;
        const contentBudget = stepBudget - utf8Bytes(serialize({ ...bounded, content: [] })) - 32;
        const itemBudget = Math.floor(contentBudget / step.content.length) - 16;
        bounded.content = step.content.map((item) => {
            if (utf8Bytes(serialize(item)) <= itemBudget) return item;
            const metadata = { type: item.type, ...marker(item) };
            if (item.omitted) return item;
            // Preserve structured cleanup/cause objects when string truncation
            // suffices; mark the containing content with its original byte size.
            for (const limit of [1024, 256, 64]) {
                const candidate = { ...JSON.parse(diagnostic(item, limit)), ...metadata };
                if (utf8Bytes(serialize(candidate)) <= itemBudget) return candidate;
            }
            const candidate = { ...metadata, diagnostic: "" };
            candidate.diagnostic = excerpt(diagnostic(item, 64), Math.max(2, itemBudget - utf8Bytes(serialize(candidate))));
            return candidate;
        });
        // Many content blocks can exceed even the marker budget. Keep the step
        // identity/outcome and explicitly bound their combined diagnostic.
        if (utf8Bytes(serialize(bounded)) > stepBudget) {
            const item = { type: "text", ...marker(step.content), contentCount: step.content.length, diagnostic: "" };
            bounded.content = [item];
            item.diagnostic = excerpt(diagnostic(step.content, 64), Math.max(2, stepBudget - utf8Bytes(serialize(bounded))));
        }
        return bounded;
    });
    return textResult(true, serialize(summary));
}

export function fail(result) {
    const detail = result.stderr
        || result.stdout
        || result.error?.message
        || (result.signal ? `signal ${result.signal}` : "")
        || `exit ${result.status}`;
    return textResult(false, `Error: ${detail}`);
}
