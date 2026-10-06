/** @typedef {Record<string, unknown>} RuntimeGenerationRecord */

/**
 * Preserve the exact auxiliary-generation and legacy-field comparison rules.
 * @param {unknown} expected
 * @param {unknown} current
 * @param {string[]} legacyIdentityFields
 */
export function runtimeGenerationMatches(expected, current, legacyIdentityFields = []) {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const previous = /** @type {RuntimeGenerationRecord} */ (expected);
    const next = /** @type {RuntimeGenerationRecord} */ (current);
    const expectedRuntimeId = typeof previous.runtimeId === "string" ? previous.runtimeId : null;
    const currentRuntimeId = typeof next.runtimeId === "string" ? next.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const presentIdentityFields = legacyIdentityFields.filter((field) => previous[field] !== undefined || next[field] !== undefined);
    return presentIdentityFields.length > 0 && presentIdentityFields.every((field) => previous[field] === next[field]);
}

/** @param {unknown} expected @param {unknown} current */
export function recordingGenerationMatches(expected, current) {
    return runtimeGenerationMatches(expected, current, [
        "authority", "processOwner", "startedBy", "pid", "provider",
        "startedAt", "remotePath", "localPath", "sessionId",
    ]);
}

/** @param {unknown} expected @param {unknown} current */
export function appiumGenerationMatches(expected, current) {
    return runtimeGenerationMatches(expected, current, [
        "authority", "processOwner", "startedBy", "serverPid", "serverUrl", "sessionId", "updatedAt",
    ]);
}
