import {createHash} from "node:crypto";
import {realpathSync} from "node:fs";
import {basename,dirname,join,resolve} from "node:path";

/**
 * Generate a 12-character SHA256 hash of a path
 */
export function hashPath(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export function canonicalProjectPath(
    projectPath: string,
    platform = process.platform,
    realpath: (path: string) => string = realpathSync.native ?? realpathSync,
): string {
    const resolved = resolve(projectPath);
    if (platform !== "win32") return resolved;
    try {
        return realpath(resolved);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error("Unable to establish canonical Windows project identity", { cause: error });
        }
        try {
            return join(realpath(dirname(resolved)), basename(resolved));
        } catch (parentError) {
            throw new Error("Unable to establish canonical Windows project parent identity", { cause: parentError });
        }
    }
}

export function projectPathsEquivalent(
    left: string,
    right: string,
    platform = process.platform,
    realpath: (path: string) => string = realpathSync.native ?? realpathSync,
): boolean {
    const canonicalLeft = canonicalProjectPath(left, platform, realpath);
    const canonicalRight = canonicalProjectPath(right, platform, realpath);
    return platform === "win32"
        ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
        : canonicalLeft === canonicalRight;
}

/**
 * Resolve the durable logical path used by container names, session locks, and
 * container working directories. This must remain filesystem-independent:
 * canonical filesystem identity is validated separately by
 * canonicalProjectPath/projectPathsEquivalent.
 */
export function projectIdentityPath(
    projectPath: string,
    pathResolver: (path: string) => string = resolve,
): string {
    return pathResolver(projectPath);
}

/**
 * Generate project ID in format: name-hash.
 */
export function getProjectId(
    projectPath: string,
    pathResolver: (path: string) => string = resolve,
): string {
    const identityPath = projectIdentityPath(projectPath, pathResolver);
    const name = basename(identityPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = hashPath(identityPath);
    return `${name}-${hash}`;
}

