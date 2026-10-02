import { symlinkSync } from "node:fs";
import type { TestContext } from "vitest";

const nativePlatform = process.platform;

/** Use only in a dedicated file-symlink test; ordinary checks must remain runnable. */
export function fileSymlinkOrSkip(context: Pick<TestContext, "skip">, target: string, path: string): void {
    try { symlinkSync(target, path, "file"); }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (nativePlatform === "win32" && (code === "EPERM" || code === "EACCES")) {
            context.skip("Windows file symlink creation requires Developer Mode or elevation");
            return;
        }
        throw error;
    }
}

export function directorySymlink(target: string, path: string): void {
    symlinkSync(target, path, nativePlatform === "win32" ? "junction" : "dir");
}
