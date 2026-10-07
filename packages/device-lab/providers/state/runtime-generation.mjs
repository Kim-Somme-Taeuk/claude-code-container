import { randomUUID } from "crypto";
import { createRuntimeGenerationTransitions } from "../application/runtime-generation.mjs";

export { runtimeGenerationMatches, recordingGenerationMatches, appiumGenerationMatches } from "../domain/runtime-generation.mjs";

// Keep native entropy and invocation-time defaults at the compatibility edge.
// Wrapping the updater preserves early returns that never call a legacy updater.
function transitions(updateDevice) {
    return createRuntimeGenerationTransitions({
        updateDevice: (deviceId, updater) => updateDevice(deviceId, updater),
        newRuntimeId: () => randomUUID(),
    });
}

export function transitionRecordingGeneration(updateDevice, deviceId, expected, replacement, updatedAt = new Date().toISOString()) {
    return transitions(updateDevice).transitionRecordingGeneration(deviceId, expected, replacement, updatedAt);
}

export function claimRecordingFinalization(updateDevice, deviceId, expected, overrides = {}, updatedAt = new Date().toISOString()) {
    return transitions(updateDevice).claimRecordingFinalization(deviceId, expected, overrides, updatedAt);
}

export function transitionAppiumGeneration(updateDevice, deviceId, expected, replacement, updatedAt = new Date().toISOString()) {
    return transitions(updateDevice).transitionAppiumGeneration(deviceId, expected, replacement, updatedAt);
}
