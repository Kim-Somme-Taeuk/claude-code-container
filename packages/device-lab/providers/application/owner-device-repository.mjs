/** @typedef {import('../ports/owner-device-repository.mjs').OwnerDeviceRecord} OwnerDeviceRecord */
/** @typedef {import('../ports/owner-device-repository.mjs').OwnerDeviceRepositoryPorts} OwnerDeviceRepositoryPorts */

/** @param {unknown[]} devices */
function assertUniqueOwnerDeviceIds(devices) {
    const ids = new Set();
    for (const value of devices) {
        const id = value && typeof value === "object"
            ? /** @type {{id?: unknown}} */ (value).id : null;
        if (typeof id !== "string" || !id) continue;
        if (ids.has(id)) {
            const error = /** @type {Error & {code?: string, deviceId?: string}} */ (
                new Error(`Owner device state contains duplicate id: ${id}`)
            );
            error.code = "owner-device-id-conflict";
            error.deviceId = id;
            throw error;
        }
        ids.add(id);
    }
}

/**
 * Repository policy has no home, owner, filesystem or lock defaults.
 * A fresh trusted composition binds the six required ports for each public
 * operation. Exceptions and synchronous results pass through unchanged.
 * @param {OwnerDeviceRepositoryPorts} ports
 */
export function createOwnerDeviceRepository(ports) {
    for (const name of /** @type {const} */ (["read", "exists", "validate", "publish", "withMutationLock", "equals"])) {
        if (!ports || typeof ports[name] !== "function") {
            throw new TypeError(`Owner device repository requires ${name}`);
        }
    }

    function read() { return ports.read(); }

    /** @param {unknown} devices */
    function write(devices) {
        return ports.withMutationLock(() => {
            if (!Array.isArray(devices)) throw new TypeError("Owner device state must be an array");
            read();
            assertUniqueOwnerDeviceIds(devices);
            ports.validate(devices);
            ports.publish(devices);
            return devices;
        });
    }

    /** @param {(current: OwnerDeviceRecord[]) => unknown} updater */
    function mutate(updater) {
        return ports.withMutationLock(() => {
            const current = read();
            const before = JSON.stringify(current);
            const existed = ports.exists();
            const next = updater(current);
            if (!Array.isArray(next)) throw new TypeError("Owner device mutation must return an array");
            assertUniqueOwnerDeviceIds(next);
            ports.validate(next);
            if (!existed || JSON.stringify(next) !== before) ports.publish(next);
            return next;
        });
    }

    /**
     * @param {unknown} device
     * @param {unknown} uniqueFields
     * @returns {{ok: true, device: OwnerDeviceRecord} | {ok: false, error: 'owner-device-id-conflict' | 'owner-device-identity-conflict', field: string, value: unknown, existing: OwnerDeviceRecord}}
     */
    function claim(device, uniqueFields = ["id"]) {
        if (!device || typeof device !== "object" || Array.isArray(device)) {
            throw new TypeError("Owner device claim requires a device object");
        }
        if (!Array.isArray(uniqueFields) || uniqueFields.length === 0 || uniqueFields.some((selector) => {
            const fields = Array.isArray(selector) ? selector : [selector];
            return fields.length === 0 || fields.some((field) => typeof field !== "string" || !field);
        })) {
            throw new TypeError("Owner device claim requires at least one unique field");
        }
        const record = /** @type {OwnerDeviceRecord} */ (device);
        const selectors = /** @type {(string | string[])[]} */ (uniqueFields);
        return ports.withMutationLock(() => {
            const devices = read();
            for (const selector of selectors) {
                const fields = Array.isArray(selector) ? selector : [selector];
                const values = fields.map((field) => record[field]);
                if (values.some((value) => value === null || value === undefined || value === "")) continue;
                const existing = devices.find((candidate) => candidate && typeof candidate === "object"
                    && fields.every((field, index) => candidate[field] === values[index]));
                if (existing) {
                    const field = fields.join("+");
                    const value = fields.length === 1 ? values[0]
                        : Object.fromEntries(fields.map((key, index) => [key, values[index]]));
                    return {
                        ok: false,
                        error: field === "id" ? "owner-device-id-conflict" : "owner-device-identity-conflict",
                        field, value, existing,
                    };
                }
            }
            const next = [...devices, record];
            ports.validate(next);
            ports.publish(next);
            return { ok: true, device: record };
        });
    }

    /** @param {unknown} id */
    function find(id) { return read().find((device) => device.id === id); }

    /**
     * @param {unknown} id
     * @param {(current: OwnerDeviceRecord) => OwnerDeviceRecord} updater
     * @returns {OwnerDeviceRecord | null}
     */
    function update(id, updater) {
        /** @type {OwnerDeviceRecord | null} */
        let updated = null;
        mutate((devices) => devices.map((device) => {
            if (device.id !== id) return device;
            updated = updater(device);
            return updated;
        }));
        return updated;
    }

    /**
     * @param {unknown} id
     * @param {unknown} expected
     * @param {OwnerDeviceRecord | null | ((current: OwnerDeviceRecord) => OwnerDeviceRecord | null)} replacement
     * @returns {{found: boolean, matched: boolean, currentDevice: OwnerDeviceRecord | null, device: OwnerDeviceRecord | null}}
     */
    function transition(id, expected, replacement) {
        let found = false;
        let matched = false;
        /** @type {OwnerDeviceRecord | null} */
        let currentDevice = null;
        /** @type {OwnerDeviceRecord | null} */
        let updatedDevice = null;
        mutate((devices) => devices.flatMap((device) => {
            if (device.id !== id) return [device];
            found = true;
            currentDevice = device;
            if (!ports.equals(device, expected)) return [device];
            matched = true;
            updatedDevice = typeof replacement === "function" ? replacement(device) : replacement;
            return updatedDevice === null ? [] : [updatedDevice];
        }));
        return { found, matched, currentDevice, device: updatedDevice };
    }

    return { read, write, mutate, claim, find, update, transition };
}
