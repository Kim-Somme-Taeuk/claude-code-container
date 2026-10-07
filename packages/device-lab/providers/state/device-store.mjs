import { createHash } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "../context.mjs";
import { createOwnerDeviceRepository } from "../application/owner-device-repository.mjs";
import { createFileOwnerDeviceRepositoryPorts } from "../adapters/state/owner-device-repository.mjs";
import { withSharedMutationLockAsync } from "./shared-mutation-lock.mjs";

const ownerDeviceOperationContext = new AsyncLocalStorage();

export function ownerStateDir(backend) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), backend);
}

export function ownerStateFile(backend) {
    return join(ownerStateDir(backend), "devices.json");
}

export function ownerStateMutationLockFile(backend) {
    return join(ownerStateDir(backend), "devices.mutation.lock");
}

export function ownerDeviceOperationLockFile(backend, deviceId) {
    if (typeof deviceId !== "string" || !deviceId) throw new TypeError("Owner device operation requires a device id");
    const key = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    return join(ownerStateDir(backend), "operations", `${key}.lock`);
}

export function withOwnerDeviceOperation(backend, deviceId, operation, options = {}) {
    if (typeof operation !== "function") throw new TypeError("Owner device operation requires a callback");
    const lockFile = ownerDeviceOperationLockFile(backend, deviceId);
    const inherited = ownerDeviceOperationContext.getStore();
    if (inherited?.get(lockFile)?.active) return Promise.resolve().then(operation);
    return withSharedMutationLockAsync(lockFile, () => {
        const token = { active: true };
        const context = new Map(inherited || []);
        context.set(lockFile, token);
        return ownerDeviceOperationContext.run(context, async () => {
            try {
                return await operation();
            } finally {
                token.active = false;
            }
        });
    }, {
        waitMs: options.waitMs ?? 30000,
        staleMs: options.staleMs ?? 15 * 60 * 1000,
    });
}

export function withOwnerDeviceOperations(backend, deviceIds, operation, options = {}) {
    if (!Array.isArray(deviceIds) || deviceIds.some((deviceId) => typeof deviceId !== "string" || !deviceId)) {
        throw new TypeError("Owner device operations require device ids");
    }
    if (typeof operation !== "function") throw new TypeError("Owner device operations require a callback");
    const ordered = [...new Set(deviceIds)].sort();
    const acquire = (index) => index >= ordered.length
        ? Promise.resolve().then(operation)
        : withOwnerDeviceOperation(backend, ordered[index], () => acquire(index + 1), options);
    return acquire(0);
}

// Bind trusted paths on the first storage operation of each public call.
// Claim input validation retains precedence over path resolution/acquisition.
// The binding is call-local, never a module-global home/owner cache.
function ownerRepository(backend) {
    let ports;
    const storage = () => ports ??= createFileOwnerDeviceRepositoryPorts({
        stateFile: ownerStateFile(backend), mutationLockFile: ownerStateMutationLockFile(backend),
    });
    return createOwnerDeviceRepository({
        read: () => storage().read(),
        exists: () => storage().exists(),
        validate: (devices) => storage().validate(devices),
        publish: (devices) => storage().publish(devices),
        withMutationLock: (operation) => storage().withMutationLock(operation),
        equals: (left, right) => storage().equals(left, right),
    });
}

export function readOwnerDevices(backend) {
    return ownerRepository(backend).read();
}

export function writeOwnerDevices(backend, devices) {
    return ownerRepository(backend).write(devices);
}

export function mutateOwnerDevices(backend, updater) {
    return ownerRepository(backend).mutate(updater);
}

export function claimOwnerDevice(backend, device, uniqueFields = ["id"]) {
    return ownerRepository(backend).claim(device, uniqueFields);
}

export function findOwnerDevice(backend, id) {
    return ownerRepository(backend).find(id);
}

export function updateOwnerDevice(backend, id, updater) {
    return ownerRepository(backend).update(id, updater);
}

export function transitionOwnerDeviceRecord(backend, id, expected, replacement) {
    return ownerRepository(backend).transition(id, expected, replacement);
}
