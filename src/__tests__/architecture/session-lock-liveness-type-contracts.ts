import {
    sessionLockOwner, parseProcessStartObservations,
    type ProcessStartObservation, type SessionLockLiveness, type SessionLockOwner,
} from "../../domain/session-lock.js";
import { createSessionLockLiveness } from "../../application/session-lock-liveness.js";
import type { SessionLockLivenessPorts } from "../../ports/session-lock-liveness.js";

const ports: SessionLockLivenessPorts = {
    getPlatform: () => "linux",
    observeProcessStart: () => ({ status: "found", token: "opaque" }),
    probeLegacyProcess: () => undefined,
};
const classify: (content: string, observed?: ReadonlyMap<number, ProcessStartObservation>) => SessionLockLiveness = createSessionLockLiveness(ports);
const observed: ReadonlyMap<number, ProcessStartObservation> = parseProcessStartObservations("42 FOUND:123", [42] as const);
const result: SessionLockLiveness = classify("42", observed);
const owner: SessionLockOwner | null = sessionLockOwner("42");
const probeResult: undefined = ports.probeLegacyProcess(42);
void [result, owner, probeResult];

// @ts-expect-error The factory requires explicit ports without defaults.
createSessionLockLiveness();
// @ts-expect-error Platform is a required port.
createSessionLockLiveness({ observeProcessStart: ports.observeProcessStart, probeLegacyProcess: ports.probeLegacyProcess });
// @ts-expect-error Observation is a required port.
createSessionLockLiveness({ getPlatform: ports.getPlatform, probeLegacyProcess: ports.probeLegacyProcess });
// @ts-expect-error Legacy probe is a required port.
createSessionLockLiveness({ getPlatform: ports.getPlatform, observeProcessStart: ports.observeProcessStart });
// @ts-expect-error Platform callbacks must be synchronous.
createSessionLockLiveness({ ...ports, getPlatform: async () => "linux" });
// @ts-expect-error Observation callbacks must be synchronous.
createSessionLockLiveness({ ...ports, observeProcessStart: async () => ({ status: "missing" as const }) });
// @ts-expect-error Undefined-returning probes reject async callbacks that void would accept.
createSessionLockLiveness({ ...ports, probeLegacyProcess: async () => undefined });
const voidProbe = (_pid: number): void => {};
// @ts-expect-error The probe contract requires undefined, not the permissive void return type.
createSessionLockLiveness({ ...ports, probeLegacyProcess: voidProbe });
// @ts-expect-error The probe cannot return a status boolean.
createSessionLockLiveness({ ...ports, probeLegacyProcess: () => true });
// @ts-expect-error Observations have a closed discriminant union.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "active" }) });
// @ts-expect-error Found observations always carry a string token.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "found" }) });
// @ts-expect-error Found tokens are strings.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "found", token: 1 }) });
// @ts-expect-error The synchronous classifier returns liveness rather than a promise.
const asynchronousResult: Promise<SessionLockLiveness> = classify("42");
void asynchronousResult;
