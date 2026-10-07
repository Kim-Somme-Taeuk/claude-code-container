import type { ProcessStartObservation, SessionLockLiveness } from "../domain/session-lock.js";

export interface SessionClaimsPorts {
    ensureDirectory(): undefined;
    listEntries(): string[];
    claimPath(name: string): string;
    claimName(path: string): string;
    readClaim(name: string): string;
    writeClaim(path: string, content: string): undefined;
    removeClaim(path: string): undefined;
    createId(): string;
    currentPid(): number;
    startToken(pid: number): string | null;
    observeOwners(pids: readonly number[]): ReadonlyMap<number, ProcessStartObservation>;
    classify(content: string, observations: ReadonlyMap<number, ProcessStartObservation>): SessionLockLiveness;
    withLifecycleLock<T>(prefix: string, operation: () => T): T;
}
