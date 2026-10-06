import { createSessionClaims } from "../../application/session-claims.js";
import type { SessionClaimsPorts } from "../../ports/session-claims.js";
import type { ProcessStartObservation } from "../../domain/session-lock.js";

const ports: SessionClaimsPorts = {
    ensureDirectory: () => undefined,
    listEntries: () => [],
    claimPath: name => `/claims/${name}`,
    claimName: path => path,
    readClaim: () => "42",
    writeClaim: () => undefined,
    removeClaim: () => undefined,
    createId: () => "id",
    currentPid: () => 42,
    startToken: () => null,
    observeOwners: (_pids: readonly number[]): ReadonlyMap<number, ProcessStartObservation> => new Map(),
    classify: () => "unknown",
    withLifecycleLock: <T>(_prefix: string, operation: () => T): T => operation(),
};
const app = createSessionClaims(ports);
const created: string = app.createSessionLock("project", "work");
const raw: string[] = app.getSessionLockClaimsForContainer("project");
const rawFamily: string[] = app.getSessionLockClaimsForProjectFamily("project");
const live: string[] = app.getActiveSessionsForContainer("project", created);
const liveFamily: string[] = app.getActiveSessionsForProjectFamily("project");
const foreignRaw: boolean = app.hasOtherSessionClaims("project", created);
const foreignLive: boolean = app.hasOtherActiveSessions("project", created);
const replaced: boolean = app.recreateContainerWithoutInterruptingSessions("project", created, () => {}, () => true);
const ensured: undefined = ports.ensureDirectory();
const written: undefined = ports.writeClaim(created, "42");
const removed: undefined = ports.removeClaim(created);
const lockedNumber: number = ports.withLifecycleLock("project", () => 42);
// Generic lock preserves callback result T; it does not ban every async supplied callback.
const lockedPromise: Promise<number> = ports.withLifecycleLock("project", async () => 42);
void [raw, rawFamily, live, liveFamily, foreignRaw, foreignLive, replaced, ensured, written, removed, lockedNumber, lockedPromise];

type RequiredNames = "ensureDirectory" | "listEntries" | "claimPath" | "claimName" | "readClaim" | "writeClaim" | "removeClaim"
    | "createId" | "currentPid" | "startToken" | "observeOwners" | "classify" | "withLifecycleLock";
type Assert<T extends true> = T;
type AllRequired = Assert<{
    [K in RequiredNames]: {} extends Pick<SessionClaimsPorts, K> ? false : true
}[RequiredNames] extends true ? true : false>;
const allRequired: AllRequired = true;
void allRequired;

// @ts-expect-error The factory has no implicit production/default ports.
createSessionClaims();
// @ts-expect-error Explicit ports cannot be absent.
createSessionClaims(undefined);
// @ts-expect-error Directory effects must be synchronous and return undefined.
createSessionClaims({ ...ports, ensureDirectory: async () => undefined });
// @ts-expect-error Enumeration must synchronously return entry names.
createSessionClaims({ ...ports, listEntries: async () => [] });
// @ts-expect-error Path capture is synchronous.
createSessionClaims({ ...ports, claimPath: async name => name });
// @ts-expect-error Basename observation is synchronous.
createSessionClaims({ ...ports, claimName: async path => path });
// @ts-expect-error Record reading is synchronous.
createSessionClaims({ ...ports, readClaim: async () => "42" });
// @ts-expect-error Undefined write results reject the permissive async-to-void assignment.
createSessionClaims({ ...ports, writeClaim: async () => undefined });
// @ts-expect-error Undefined removal results reject async effects.
createSessionClaims({ ...ports, removeClaim: async () => undefined });
// @ts-expect-error ID generation is synchronous.
createSessionClaims({ ...ports, createId: async () => "id" });
// @ts-expect-error Current process observation is synchronous.
createSessionClaims({ ...ports, currentPid: async () => 42 });
// @ts-expect-error Token observation is synchronous.
createSessionClaims({ ...ports, startToken: async () => null });
// @ts-expect-error Batch observations synchronously return the exact map shape.
createSessionClaims({ ...ports, observeOwners: async () => new Map<number, ProcessStartObservation>() });
// @ts-expect-error Classification is synchronous.
createSessionClaims({ ...ports, classify: async () => "unknown" as const });
// @ts-expect-error The generic lock implementation must return T rather than Promise<T>.
createSessionClaims({ ...ports, withLifecycleLock: async <T>(_prefix: string, operation: () => T) => operation() });
const voidEffect = (): void => {};
// @ts-expect-error Explicit undefined does not accept permissive void directory effects.
createSessionClaims({ ...ports, ensureDirectory: voidEffect });
// @ts-expect-error Explicit undefined does not accept permissive void write effects.
createSessionClaims({ ...ports, writeClaim: voidEffect });
// @ts-expect-error Explicit undefined does not accept permissive void removal effects.
createSessionClaims({ ...ports, removeClaim: voidEffect });
// @ts-expect-error A successful batch found observation requires a string token.
createSessionClaims({ ...ports, observeOwners: () => new Map([[42, { status: "found" }]]) });
// @ts-expect-error Liveness discriminants are closed.
createSessionClaims({ ...ports, classify: () => "dead" });
// @ts-expect-error Reservation returns a synchronous path.
const asynchronousCreated: Promise<string> = app.createSessionLock("project");
// @ts-expect-error Replacement returns a synchronous decision.
const asynchronousReplaced: Promise<boolean> = app.recreateContainerWithoutInterruptingSessions("project", created, () => {});
void [asynchronousCreated, asynchronousReplaced];
