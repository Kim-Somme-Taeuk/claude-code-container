import { randomBytes } from "crypto";
import { createSessionClaimsStore } from "../adapters/session-claims-store.js";
import { createSessionClaims } from "../application/session-claims.js";
import { locksDir } from "../home-layout.js";
import type { SessionClaimsPorts } from "../ports/session-claims.js";
import { observeProcessStarts, processStartToken, sessionLockLiveness } from "../session-lock-liveness.js";

const store = createSessionClaimsStore({
    directory: () => locksDir(),
    platform: () => process.platform,
});

export function ensureNativeSessionClaimsDirectory(): undefined {
    return store.ensureDirectory();
}

export function createNativeSessionClaims(withLifecycleLock: SessionClaimsPorts["withLifecycleLock"]) {
    return createSessionClaims({
        ...store,
        createId: () => randomBytes(16).toString("hex"),
        currentPid: () => process.pid,
        startToken: (pid) => processStartToken(pid),
        observeOwners: (pids) => observeProcessStarts(pids),
        classify: (content, observations) => sessionLockLiveness(content, observations),
        withLifecycleLock,
    });
}
