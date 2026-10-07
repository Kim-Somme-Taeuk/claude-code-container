import { basename, dirname, join, resolve } from "path";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";
import { armSessionOwnership } from "../application/session-ownership.js";
import {
    captureNativeSessionOwnership, launchNativeSessionOwnership,
    nativeSessionOwnershipMatches, removeCapturedNativeSessionOwnership,
} from "../adapters/session-ownership.js";
import { sessionClaimPrefix, sessionLockClaimsForContainer } from "../domain/session-claims.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import { locksDir } from "../home-layout.js";
import { getProjectId } from "../utils.js";
import { setRuntimeOverride } from "../container-runtime.js";
import { createNativeSessionClaims, ensureNativeSessionClaimsDirectory } from "./session-claims.js";
import { createNativeSessionCleanup } from "./session-cleanup.js";
import type {
    SessionOwnershipBinding, SessionOwnershipHandle, SessionOwnershipReceipt, SessionOwnershipRuntime,
} from "../ports/session-ownership.js";

function withLifecycleLock<T>(prefix: string, operation: () => T): T {
    ensureNativeSessionClaimsDirectory();
    return withSharedMutationLock(join(locksDir(), `${prefix}.container-lifecycle.guard`), operation, { waitMs: 180_000 });
}

export function validateNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt, ownerPid: number,
): void {
    if (!binding || !receipt || typeof binding.lockFile !== "string" || typeof binding.projectPath !== "string"
        || !binding.projectPath.length || (binding.profile !== undefined && typeof binding.profile !== "string")
        || (binding.toolName !== undefined && typeof binding.toolName !== "string")
        || typeof receipt.path !== "string" || receipt.path !== binding.lockFile
        || resolve(receipt.path) !== receipt.path || dirname(receipt.path) !== resolve(locksDir())
        || typeof receipt.bytes !== "string" || receipt.bytes.length > 8192
        || typeof receipt.device !== "string" || typeof receipt.inode !== "string"
        || typeof receipt.birthtime !== "string" || receipt.ownerPid !== ownerPid) {
        throw new Error("Invalid session ownership binding.");
    }
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    const owner = sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"));
    if (owner?.pid !== ownerPid || !sessionLockClaimsForContainer([basename(receipt.path)], prefix).length) {
        throw new Error("Session ownership record does not match its owner or project.");
    }
}

export function assertNativeSessionOwnership(receipt: SessionOwnershipReceipt): void {
    if (!nativeSessionOwnershipMatches(receipt)) throw new Error("Session ownership receipt is absent, unreadable, or replaced.");
}

export function cleanupCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
    containerId: string | null = null, runtime: SessionOwnershipRuntime = "docker",
): void {
    const claims = createNativeSessionClaims(withLifecycleLock);
    const cleanup = createNativeSessionCleanup(
        (prefix, operation) => withLifecycleLock(prefix, () => {
            if (!nativeSessionOwnershipMatches(receipt)) return undefined as ReturnType<typeof operation>;
            return operation();
        }),
        (prefix, ownPath) => claims.hasOtherReconciledSessionClaims(prefix, ownPath),
        () => removeCapturedNativeSessionOwnership(receipt),
        "ended-owner",
    );
    if (containerId !== null) setRuntimeOverride(runtime);
    cleanup.setSession(binding.lockFile, binding.projectPath, binding.profile, binding.toolName);
    cleanup.setSessionContainerId(containerId);
    cleanup.cleanupSession();
}

export function rollbackCapturedNativeSessionOwnership(
    binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt,
): void {
    const prefix = sessionClaimPrefix(getProjectId(binding.projectPath), binding.profile);
    withLifecycleLock(prefix, () => {
        if (nativeSessionOwnershipMatches(receipt)) removeCapturedNativeSessionOwnership(receipt);
    });
}

export interface NativeSessionOwnershipOptions {
    onCaptured?(receipt: SessionOwnershipReceipt): void;
    rollback?(binding: SessionOwnershipBinding, receipt: SessionOwnershipReceipt): void;
}

export async function armNativeSessionOwnership(
    binding: SessionOwnershipBinding, onFailure: (error: Error) => void,
    options: NativeSessionOwnershipOptions = {},
): Promise<SessionOwnershipHandle> {
    binding = Object.freeze({ ...binding });
    const receipt = Object.freeze(captureNativeSessionOwnership(binding.lockFile));
    validateNativeSessionOwnership(binding, receipt, process.pid);
    options.onCaptured?.(receipt);
    return armSessionOwnership(binding, receipt, {
        launch: launchNativeSessionOwnership,
        cleanup: options.rollback ?? rollbackCapturedNativeSessionOwnership,
        assertOwnership: () => assertNativeSessionOwnership(receipt),
        setTimer: (callback, milliseconds) => {
            const timer: { timeout?: ReturnType<typeof setTimeout>; immediate?: ReturnType<typeof setImmediate> } = {};
            // Synchronous setup can block the host loop beyond the deadline.
            // Give already-arrived IPC ACKs one I/O iteration before timeout.
            timer.timeout = setTimeout(() => { timer.immediate = setImmediate(callback); }, milliseconds);
            return timer;
        },
        clearTimer: (value) => {
            const timer = value as { timeout?: ReturnType<typeof setTimeout>; immediate?: ReturnType<typeof setImmediate> };
            clearTimeout(timer.timeout);
            if (timer.immediate) clearImmediate(timer.immediate);
        },
        timeoutMs: 5000,
    }, onFailure);
}
