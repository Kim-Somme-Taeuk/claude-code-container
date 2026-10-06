import { createRuntimeGenerationTransitions } from "../../../packages/device-lab/providers/application/runtime-generation.mjs";
import type { GenerationRecord, RuntimeGenerationPorts } from "../../../packages/device-lab/providers/ports/runtime-generation.mjs";

const ports: RuntimeGenerationPorts = {
    updateDevice: (_id, updater) => updater({ id: "typed", recording: null }),
    newRuntimeId: () => "next-generation",
};
const transitions = createRuntimeGenerationTransitions(ports);
const recording = transitions.transitionRecordingGeneration("typed", null, { runtimeId: "next" }, "timestamp");
const appium = transitions.transitionAppiumGeneration("typed", null, { runtimeId: "next" }, "timestamp");
const finalizing = transitions.claimRecordingFinalization("typed", { runtimeId: "previous" }, {}, "timestamp");
const committed: boolean = recording.committed;
const actualDevice: GenerationRecord | null = recording.device;
// Direct property access catches null-only inference from callback assignments.
const fields: unknown[] = [recording.device?.recording, appium.device?.appium, finalizing.device?.id];
void [committed, actualDevice, fields];

// @ts-expect-error all effect ports are required
createRuntimeGenerationTransitions({ updateDevice: ports.updateDevice });
// @ts-expect-error there are no ambient effect defaults
createRuntimeGenerationTransitions();
// @ts-expect-error updater effects must remain synchronous
createRuntimeGenerationTransitions({ ...ports, updateDevice: async () => ({ id: "typed" }) });
// @ts-expect-error entropy effects must remain synchronous strings
createRuntimeGenerationTransitions({ ...ports, newRuntimeId: async () => "next" });
// @ts-expect-error operation time must be supplied explicitly to the core
transitions.transitionRecordingGeneration("typed", null, {});
// @ts-expect-error finalization time must be supplied explicitly to the core
transitions.claimRecordingFinalization("typed", {}, {});
