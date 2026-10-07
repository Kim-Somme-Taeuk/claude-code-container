import { appiumGenerationMatches, recordingGenerationMatches } from "../domain/runtime-generation.mjs";

/** @typedef {import('../ports/runtime-generation.mjs').GenerationRecord} GenerationRecord */
/** @typedef {import('../ports/runtime-generation.mjs').RuntimeGenerationPorts} RuntimeGenerationPorts */
/** @typedef {{committed: boolean, device: GenerationRecord | null}} GenerationTransition */

/** @param {RuntimeGenerationPorts} ports */
export function createRuntimeGenerationTransitions(ports) {
    for (const name of /** @type {const} */ (["updateDevice", "newRuntimeId"])) {
        if (!ports || typeof ports[name] !== "function") {
            throw new TypeError(`Runtime generation transitions require ${name}`);
        }
    }

    /**
     * @param {unknown} deviceId
     * @param {unknown} expected
     * @param {unknown} replacement
     * @param {unknown} updatedAt
     * @returns {GenerationTransition}
     */
    function transitionRecordingGeneration(deviceId, expected, replacement, updatedAt) {
        let committed = false;
        const device = ports.updateDevice(deviceId, (current) => {
            if (!recordingGenerationMatches(expected, current.recording)) return current;
            committed = true;
            return { ...current, recording: replacement, updatedAt };
        });
        return { committed, device };
    }

    /**
     * @param {unknown} deviceId
     * @param {unknown} expected
     * @param {unknown} overrides
     * @param {unknown} updatedAt
     * @returns {GenerationTransition}
     */
    function claimRecordingFinalization(deviceId, expected, overrides, updatedAt) {
        if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
            return { committed: false, device: null };
        }
        const recording = /** @type {GenerationRecord} */ (expected);
        const replacement = {
            ...recording,
            .../** @type {GenerationRecord} */ (overrides),
            active: false,
            recorderRuntimeId: recording.recorderRuntimeId || recording.runtimeId || null,
            runtimeId: ports.newRuntimeId(),
            finalizingAt: updatedAt,
        };
        return transitionRecordingGeneration(deviceId, expected, replacement, updatedAt);
    }

    /**
     * @param {unknown} deviceId
     * @param {unknown} expected
     * @param {unknown} replacement
     * @param {unknown} updatedAt
     * @returns {GenerationTransition}
     */
    function transitionAppiumGeneration(deviceId, expected, replacement, updatedAt) {
        let committed = false;
        const device = ports.updateDevice(deviceId, (current) => {
            if (!appiumGenerationMatches(expected, current.appium)) return current;
            committed = true;
            return { ...current, appium: replacement, updatedAt };
        });
        return { committed, device };
    }

    return { transitionRecordingGeneration, claimRecordingFinalization, transitionAppiumGeneration };
}
