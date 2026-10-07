/**
 * Facts supplied by the transport adapter. Helper evidence is already redacted.
 * @typedef {{ready: boolean, failed: boolean, helper?: Record<string, unknown>}} ReadinessObservation
 * @typedef {{attempts: number, lastProbe: string, helper?: Record<string, unknown>, helperAttempt?: number}} ReadinessEvidence
 * @typedef {{kind: 'ready'} | {kind: 'timed-out', readiness: ReadinessEvidence}} ReadinessOutcome
 * @typedef {{timeoutMs: number, remainingMs: number}} ReadinessProbeBudget
 */

/**
 * Preserve the desktop readiness loop's positive budget and 10-second probe cap.
 * This is an observation of the caller's original deadline, not a new timeout.
 * @param {number} deadline
 * @param {number} observedAt
 * @returns {ReadinessProbeBudget | undefined}
 */
export function readinessProbeBudget(deadline, observedAt) {
    const remainingMs = deadline - observedAt;
    if (remainingMs <= 0) return undefined;
    return { timeoutMs: Math.min(10000, remainingMs), remainingMs };
}
