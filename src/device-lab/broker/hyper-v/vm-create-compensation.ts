import { promises as fsPromises } from "fs";
import { resolve } from "path";

import {
    planHyperVVirtualMachineCreationCompensation,
    type HyperVCreateCompensation,
    type HyperVCreateEffect,
} from "../../../hyper-v-windows/lifecycle/index.js";
import { assertNoSymlinkPathComponents } from "./image-store.js";

/**
 * Undoes the part of creation that Node did, from what Node recorded doing.
 *
 * The plan comes from slice 3A: effects in, compensations out, reversed. Nothing here
 * re-derives an undo from the request, which is the property that keeps creation from
 * deleting a device root it found rather than made.
 *
 * Only two of the three compensation kinds are reachable from here. `remove-vm` requires a
 * `vm-created` effect, and no VM exists yet at this point in creation -- that is 3B-2's half.
 * A `remove-vm` arriving here means an effect was recorded by something that had no business
 * recording it, so it is refused rather than ignored.
 */

export type HyperVCompensationAttempt = {
    readonly compensation: HyperVCreateCompensation;
    readonly ok: boolean;
    readonly error?: string;
};

/**
 * `delete-directory` is NON-RECURSIVE, and that is a decision rather than an oversight.
 *
 * Slice 3A left the recursion question open and both of its reviews called it the single most
 * important thing to settle before an executor existed, because a compensation that follows a
 * junction out of the device root is the failure the legacy's `Assert-NoReparsePath` guard was
 * written to prevent.
 *
 * Reverse order is what makes non-recursive sufficient. Creation makes the device root, then
 * the disk directory inside it, then the disk. Undoing in reverse deletes the disk first, then
 * the disk directory (now empty), then the device root (now empty). A directory that is not
 * empty when its turn comes holds something creation did not make, and refusing to remove it
 * is the correct outcome, not a failure to clean up.
 *
 * The device root is separately covered: `cleanupHyperVDeviceArtifacts` removes the whole
 * private root recursively behind a quarantine and a path predicate, and the broker runs it on
 * every create failure. This does not need to be the mechanism that handles the hard cases.
 */
async function removeDirectoryIfEmpty(path: string): Promise<void> {
    const absolute = resolve(path);
    // A symlinked component would make the path name a directory somewhere else entirely.
    // Checked immediately before the removal rather than once at the top, because the whole
    // point of compensation is that it runs after something went wrong. This covers the final
    // component too, so there is no separate symlink check below -- there was one, and it was
    // dead code that no mutation could kill.
    assertNoSymlinkPathComponents(absolute, "hyper-v-create-compensation");
    // Not a safety guard: `rmdir` refuses a non-directory by itself. It is here so the report
    // names the condition instead of carrying a raw errno string, since these attempts are
    // read by a human deciding whether residue was left behind.
    if (!(await fsPromises.lstat(absolute)).isDirectory()) {
        throw new Error("hyper-v-create-compensation-path-invalid");
    }
    await fsPromises.rmdir(absolute);
}

async function removeFile(path: string): Promise<void> {
    const absolute = resolve(path);
    // The whole path, final component included: unlinking through a symlinked directory
    // component would delete a file creation never made.
    assertNoSymlinkPathComponents(absolute, "hyper-v-create-compensation");
    if (!(await fsPromises.lstat(absolute)).isFile()) {
        throw new Error("hyper-v-create-compensation-path-invalid");
    }
    await fsPromises.unlink(absolute);
}

/**
 * Runs every compensation the effects call for, and reports rather than throws.
 *
 * Best-effort and independent, as slice 3A's contract states and as the legacy `catch` was: a
 * failure to remove the disk still lets the device root be removed. A caller that stopped at
 * the first error would leave exactly the residue the rest of the sequence exists to clear.
 *
 * It never throws, because it runs on a path where something has already failed. The failure
 * that triggered compensation is the one worth reporting; what happened during cleanup belongs
 * beside it, never in front of it.
 */
export async function runHyperVCreateCompensation(
    effects: readonly HyperVCreateEffect[],
): Promise<readonly HyperVCompensationAttempt[]> {
    const attempts: HyperVCompensationAttempt[] = [];
    for (const compensation of planHyperVVirtualMachineCreationCompensation(effects)) {
        try {
            if (compensation.kind === "delete-file") {
                await removeFile(compensation.path);
            } else if (compensation.kind === "delete-directory") {
                await removeDirectoryIfEmpty(compensation.path);
            } else {
                // A VM cannot exist yet on this path, so an effect that asks for one to be
                // removed is a bug in whatever recorded it, not a host state to act on.
                throw new Error("hyper-v-create-compensation-unsupported");
            }
            attempts.push({ compensation, ok: true });
        } catch (error) {
            attempts.push({
                compensation,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return attempts;
}
