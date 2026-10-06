import type { ProcessStartObservation } from "../domain/session-lock.js";

export interface SessionLockLivenessPorts {
    getPlatform(): string;
    observeProcessStart(pid: number): ProcessStartObservation;
    probeLegacyProcess(pid: number): undefined;
}
