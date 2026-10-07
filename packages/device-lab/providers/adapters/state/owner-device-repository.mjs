import { existsSync } from "fs";
import { isDeepStrictEqual } from "util";
import { createOwnerDeviceRepository } from "../../application/owner-device-repository.mjs";
import { assertOwnerDeviceStateWritable, readOwnerDeviceStateFile } from "../../state/owner-device-state.mjs";
import { withSharedMutationLock, writeJsonFileAtomically } from "../../state/shared-mutation-lock.mjs";

/**
 * Bind existing native storage primitives to explicit trusted filenames.
 * This adapter never derives a home/project/owner and is not a wire entrypoint.
 * @param {{stateFile: string, mutationLockFile: string}} binding
 */
export function createFileOwnerDeviceRepositoryPorts(binding) {
    if (!binding || typeof binding.stateFile !== "string" || !binding.stateFile
        || typeof binding.mutationLockFile !== "string" || !binding.mutationLockFile) {
        throw new TypeError("Owner device repository requires explicit state and mutation lock files");
    }
    const { stateFile, mutationLockFile } = binding;
    return {
        read: () => readOwnerDeviceStateFile(stateFile),
        exists: () => existsSync(stateFile),
        validate: (devices) => assertOwnerDeviceStateWritable(devices),
        publish: (devices) => writeJsonFileAtomically(stateFile, { devices }),
        withMutationLock: (operation) => withSharedMutationLock(mutationLockFile, operation),
        equals: isDeepStrictEqual,
    };
}

/** @param {{stateFile: string, mutationLockFile: string}} binding */
export function createFileOwnerDeviceRepository(binding) {
    return createOwnerDeviceRepository(createFileOwnerDeviceRepositoryPorts(binding));
}
