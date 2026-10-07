import {
    encodeSessionClaim,
    sessionClaimName,
    sessionClaimPrefix,
    sessionLockClaimsForContainer,
    sessionLockClaimsForProjectFamily,
} from "../domain/session-claims.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import type { SessionClaimsPorts } from "../ports/session-claims.js";

export function createSessionClaims(ports: SessionClaimsPorts) {
    for (const name of [
        "ensureDirectory", "listEntries", "claimPath", "claimName", "readClaim",
        "writeClaim", "removeClaim", "createId", "currentPid", "startToken",
        "observeOwners", "classify", "withLifecycleLock",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Session claims requires a callable ${name} port.`);
        }
    }

    function createSessionLock(projectId: string, profile?: string): string {
        ports.ensureDirectory();
        const sessionId = ports.createId();
        const prefix = sessionClaimPrefix(projectId, profile);
        const lockFile = ports.claimPath(sessionClaimName(prefix, sessionId));
        ports.withLifecycleLock(prefix, () => {
            filterLiveSessionLocks(getSessionLockClaimsForContainer(prefix));
            const startToken = ports.startToken(ports.currentPid());
            ports.writeClaim(lockFile, encodeSessionClaim(ports.currentPid(), startToken));
        });
        return lockFile;
    }

    function reserveSessionLockInHeldLifecycleLock(projectId: string, profile?: string): string {
        ports.ensureDirectory();
        const sessionId = ports.createId();
        const prefix = sessionClaimPrefix(projectId, profile);
        const lockFile = ports.claimPath(sessionClaimName(prefix, sessionId));
        const startToken = ports.startToken(ports.currentPid());
        ports.writeClaim(lockFile, encodeSessionClaim(ports.currentPid(), startToken));
        return lockFile;
    }

    function getSessionLockClaimsForContainer(containerPrefix: string): string[] {
        ports.ensureDirectory();
        return sessionLockClaimsForContainer(ports.listEntries(), containerPrefix);
    }

    function getSessionLockClaimsForProjectFamily(projectId: string): string[] {
        ports.ensureDirectory();
        return sessionLockClaimsForProjectFamily(ports.listEntries(), projectId);
    }

    function filterLiveSessionLocks(locks: string[], currentLockFile?: string, observationOnly = false): string[] {
        const currentLockName = currentLockFile ? ports.claimName(currentLockFile) : null;
        let currentOwnerPid: number | null = null;
        if (currentLockName && locks.includes(currentLockName)) {
            try {
                const currentOwner = sessionLockOwner(ports.readClaim(currentLockName).trim());
                if (currentOwner?.pid === ports.currentPid()) currentOwnerPid = currentOwner.pid;
            } catch {
                // Without valid current ownership, preserve other claims.
            }
        }
        const claims = locks.map((name) => {
            try {
                return { name, content: ports.readClaim(name).trim() };
            } catch {
                return { name, content: null as string | null };
            }
        });
        const observedOwners = ports.observeOwners(claims.flatMap(({ content }) => {
            const owner = content === null ? null : sessionLockOwner(content);
            return owner ? [owner.pid] : [];
        }));
        return claims.filter(({ name, content }) => {
            const lockPath = ports.claimPath(name);
            if (content === null) return true;
            try {
                const owner = sessionLockOwner(content);
                if (name !== currentLockName
                    && currentOwnerPid === ports.currentPid()
                    && owner?.pid === currentOwnerPid
                    && !owner.startToken) {
                    if (!observationOnly) {
                        try { ports.removeClaim(lockPath); } catch { /* best effort */ }
                    }
                    return false;
                }
                if (ports.classify(content, observedOwners) === "stale") {
                    if (!observationOnly) {
                        try { ports.removeClaim(lockPath); } catch { /* best effort */ }
                    }
                    return false;
                }
                return true;
            } catch {
                // Uncertain observations cannot authorize destructive replacement.
                return true;
            }
        }).map(({ name }) => name);
    }

    function getActiveSessionsForContainer(containerPrefix: string, currentLockFile?: string): string[] {
        return filterLiveSessionLocks(getSessionLockClaimsForContainer(containerPrefix), currentLockFile);
    }

    function observeActiveSessionsForContainer(containerPrefix: string, currentLockFile?: string): string[] {
        return filterLiveSessionLocks(getSessionLockClaimsForContainer(containerPrefix), currentLockFile, true);
    }

    function getActiveSessionsForProjectFamily(projectId: string): string[] {
        return filterLiveSessionLocks(getSessionLockClaimsForProjectFamily(projectId));
    }

    function hasOtherActiveSessions(containerPrefix: string, currentLockFile: string): boolean {
        const sessions = getActiveSessionsForContainer(containerPrefix);
        const currentLockName = ports.claimName(currentLockFile);
        return sessions.some((name) => name !== currentLockName);
    }

    function hasOtherSessionClaims(containerPrefix: string, currentLockFile: string): boolean {
        const claims = getSessionLockClaimsForContainer(containerPrefix);
        const currentLockName = ports.claimName(currentLockFile);
        return claims.some((name) => name !== currentLockName);
    }

    function hasOtherReconciledSessionClaims(containerPrefix: string, currentLockFile: string): boolean {
        const currentLockName = ports.claimName(currentLockFile);
        filterLiveSessionLocks(getSessionLockClaimsForContainer(containerPrefix)
            .filter((name) => name !== currentLockName));
        return hasOtherSessionClaims(containerPrefix, currentLockFile);
    }

    function recreateContainerWithoutInterruptingSessions(
        containerPrefix: string,
        currentLockFile: string,
        recreate: () => void,
        replacementAllowed: () => boolean = () => true,
    ): boolean {
        return ports.withLifecycleLock(containerPrefix, () => {
            if (!replacementAllowed()) return false;
            if (hasOtherActiveSessions(containerPrefix, currentLockFile)) return false;
            recreate();
            return true;
        });
    }

    return {
        createSessionLock,
        reserveSessionLockInHeldLifecycleLock,
        getSessionLockClaimsForContainer,
        getSessionLockClaimsForProjectFamily,
        getActiveSessionsForContainer,
        observeActiveSessionsForContainer,
        getActiveSessionsForProjectFamily,
        hasOtherActiveSessions,
        hasOtherSessionClaims,
        hasOtherReconciledSessionClaims,
        reconcileForeignClaimsInHeldLifecycleLock: hasOtherReconciledSessionClaims,
        recreateContainerWithoutInterruptingSessions,
    };
}
