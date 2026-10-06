import { randomBytes } from "crypto";
import { closeSync, fstatSync, lstatSync, openSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { constants, tmpdir } from "os";
import { join } from "path";

interface EnvFileIdentity {
    device: bigint;
    inode: bigint;
    birthtime: bigint;
}

function errorCode(error: unknown): string | undefined {
    try {
        if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
        const code = error.code;
        return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
            && Object.hasOwn(constants.errno, code) ? code : undefined;
    } catch {
        return undefined;
    }
}

function warnCleanup(error?: unknown): void {
    try {
        const code = errorCode(error);
        writeSync(2, `Warning: temporary environment file cleanup failed${code ? ` (${code})` : ""}.\n`);
    } catch {
        // Diagnostics cannot change the initiating error or process status.
    }
}

function removeOwnedEnvFile(path: string, identity: EnvFileIdentity): void {
    try {
        const current = lstatSync(path, { bigint: true });
        if (!current.isFile()) return;
        if (typeof current.dev !== "bigint" || typeof current.ino !== "bigint" || current.ino <= 0n
            || typeof current.birthtimeNs !== "bigint" || typeof current.nlink !== "bigint") {
            throw new Error("Cannot establish temporary environment file identity.");
        }
        if (current.nlink !== 1n || current.dev !== identity.device || current.ino !== identity.inode
            || current.birthtimeNs !== identity.birthtime) return;
        // This protects observed replacements, not the native lstat-to-unlink race.
        unlinkSync(path);
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
    }
}

function createNativeEnvFile(entries: Array<[string, string]>): { path: string; identity: EnvFileIdentity } {
    const path = join(tmpdir(), `ccc-env-${randomBytes(6).toString("hex")}`);
    const lines: string[] = [];
    for (const [key, value] of entries) {
        if (value.includes("\n") || value.includes("\r") || value.includes("\0")) continue;
        lines.push(`${key}=${value}`);
    }
    const fd = openSync(path, "wx", 0o600);
    let identity: EnvFileIdentity | undefined;
    let closeAttempted = false;
    try {
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || typeof stat.dev !== "bigint"
            || typeof stat.ino !== "bigint" || stat.ino <= 0n || typeof stat.birthtimeNs !== "bigint") {
            throw new Error("Cannot establish temporary environment file identity.");
        }
        identity = { device: stat.dev, inode: stat.ino, birthtime: stat.birthtimeNs };
        writeFileSync(fd, lines.join("\n") + "\n");
        closeAttempted = true;
        closeSync(fd);
        return { path, identity };
    } catch (error) {
        // Without creating-FD identity even an empty placeholder is uncertain.
        let cleanupFailed = !identity;
        let cleanupFailure: unknown;
        if (!closeAttempted) {
            try { closeSync(fd); } catch (closeError) { cleanupFailed = true; cleanupFailure = closeError; }
        }
        if (identity) {
            try { removeOwnedEnvFile(path, identity); } catch (cleanupError) {
                cleanupFailed = true;
                cleanupFailure = cleanupError;
            }
        }
        if (cleanupFailed) warnCleanup(cleanupFailure);
        throw error;
    }
}

export function writeNativeEnvFile(entries: Array<[string, string]>): string {
    return createNativeEnvFile(entries).path;
}

export function writeOwnedNativeEnvFile(entries: Array<[string, string]>): { path: string; dispose(): void } {
    const { path, identity } = createNativeEnvFile(entries);
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        let failed = false;
        let failure: unknown;
        try { process.off("exit", dispose); } catch (error) { failed = true; failure = error; }
        try { removeOwnedEnvFile(path, identity); } catch (error) { failed = true; failure = error; }
        if (failed) warnCleanup(failure);
    };
    try {
        process.on("exit", dispose);
    } catch (error) {
        dispose();
        throw error;
    }
    return { path, dispose };
}
