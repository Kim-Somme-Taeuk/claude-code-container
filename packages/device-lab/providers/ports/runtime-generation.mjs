/** @typedef {import('../domain/runtime-generation.mjs').RuntimeGenerationRecord} GenerationRecord */

/**
 * Trusted synchronous mutation and entropy effects. The existing repository
 * owns its locks and persistence; timestamps are explicit operation inputs.
 * @typedef {{
 *   updateDevice: (id: unknown, updater: (current: GenerationRecord) => GenerationRecord) => GenerationRecord | null,
 *   newRuntimeId: () => string
 * }} RuntimeGenerationPorts
 */
export {};
