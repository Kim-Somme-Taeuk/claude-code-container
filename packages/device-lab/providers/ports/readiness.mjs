/**
 * The adapter supplies a clock in the same timebase as the original deadline.
 * Probe and sleep must honor their budgets. No implicit clock or transport exists.
 * @typedef {import('../domain/readiness.mjs').ReadinessObservation} ReadinessObservation
 * @typedef {import('../domain/readiness.mjs').ReadinessProbeBudget} ReadinessProbeBudget
 * @typedef {{probe: (budget: ReadinessProbeBudget) => Promise<ReadinessObservation>, now: () => number, sleep: (ms: number) => Promise<void>}} ReadinessPorts
 */
export {};
