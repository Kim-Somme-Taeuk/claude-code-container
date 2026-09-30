// Public creation describes either real provisioning or explicit resource reuse.
// Private provider flags remain available to internal definition-only callers.
const COMMON_FIELDS = ["backend", "name", "deviceId", "detail"];
const BACKEND_FIELDS = {
    "android-emulator": ["avdName", "systemImage", "deviceProfile", "port", "headless"],
    "ios-simulator": ["simulatorName", "deviceType", "runtime", "udid"],
    "windows-sandbox": ["networking", "clipboard", "vgpu", "memoryMb", "minimized"],
    "windows-vm": ["provider", "image", "sourceImage", "profile", "switchName", "secureBootTemplate", "memoryMb", "cpus", "force", "dryRun"],
    "macos-vm": ["provider", "image", "memoryMb", "cpus", "headless", "sshHost", "sshPort", "sshUser", "sshKeyPath", "sshPassword"],
    "linux-vm": ["provider", "image", "sourceImage", "profile", "switchName", "secureBootTemplate", "baseImageId", "memoryMb", "cpus", "guestSshHost", "guestSshPort", "guestSshUser", "guestSshKeyPath", "guestReadinessCommand", "guestAgentName", "guestAgentHealthCommand", "guestAgentProvisionCommand", "guestAgentAutoProvision", "force", "dryRun"],
};
const PROVIDERS = {
    "windows-vm": ["auto", "hyper-v"],
    "macos-vm": ["auto", "tart", "vz", "utmctl"],
    "linux-vm": ["auto", "hyper-v", "container-qemu"],
};
const ALL_FIELDS = new Set([...COMMON_FIELDS, ...Object.values(BACKEND_FIELDS).flat()]);
const BOOLEAN_FIELDS = new Set(["detail", "headless", "minimized", "networking", "clipboard", "vgpu", "guestAgentAutoProvision", "force", "dryRun"]);
const NUMBER_FIELDS = new Set(["port", "memoryMb", "cpus", "sshPort", "guestSshPort"]);
const TRANSPORT_FIELDS = new Set(["broker", "viaBroker", "implicitBroker", "hostCandidates", "host", "brokerPort", "autolaunch", "timeoutMs", "rpcTimeoutMs", "launchTimeoutMs", "launchHost", "probe"]);
const present = value => typeof value === "string" && value.trim().length > 0;

export function createInputError(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "create arguments must be an object";
    if (Object.hasOwn(args, "createAvd") || Object.hasOwn(args, "createSimulator")) return "create provisions resources automatically; omit createAvd/createSimulator (use avdName or udid only to reuse an existing resource)";
    if (!Object.hasOwn(BACKEND_FIELDS, args.backend)) return "create requires a supported backend";
    if (!present(args.name)) return "create requires a nonempty name";
    if (args.deviceId !== undefined && (typeof args.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/.test(args.deviceId))) return "device-id-invalid";
    const allowed = new Set([...COMMON_FIELDS, ...BACKEND_FIELDS[args.backend]]);
    for (const [key, value] of Object.entries(args)) {
        if (!ALL_FIELDS.has(key)) {
            if (TRANSPORT_FIELDS.has(key)) continue;
            return `create does not support ${key}`;
        }
        if (!allowed.has(key)) return `create ${args.backend} does not support ${key}`;
        if (BOOLEAN_FIELDS.has(key)) {
            if (typeof value !== "boolean") return `create ${key} must be a boolean`;
        } else if (NUMBER_FIELDS.has(key)) {
            if (!Number.isInteger(value)) return `create ${key} must be an integer`;
        } else if (typeof value !== "string" || value.includes("\0")) return `create ${key} must be a string without NUL`;
    }
    if (args.deviceId !== undefined && !present(args.deviceId)) return "create deviceId must be nonempty";
    if (args.provider !== undefined && !PROVIDERS[args.backend]?.includes(args.provider)) return `create ${args.backend} does not support provider ${args.provider}`;
    if (args.memoryMb !== undefined && (args.memoryMb < 1024 || args.memoryMb > 131072)) return "create memoryMb must be from 1024 to 131072";
    if (args.cpus !== undefined && (args.cpus < 1 || args.cpus > 64)) return "create cpus must be from 1 to 64";
    for (const key of ["sshPort", "guestSshPort"]) if (args[key] !== undefined && (args[key] < 1 || args[key] > 65535)) return `create ${key} must be from 1 to 65535`;
    if (args.backend === "android-emulator") {
        if (args.avdName !== undefined && !present(args.avdName)) return "create avdName must identify an existing AVD; omit it to provision a new AVD";
        if (!present(args.avdName) && !present(args.systemImage)) return "create Android requires systemImage for a new AVD, or avdName to reuse an existing AVD; no SDK image is downloaded automatically";
        if (args.systemImage !== undefined && !/^system-images;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+$/.test(args.systemImage)) return "create systemImage must be an Android system-images package identifier";
        if (args.deviceProfile !== undefined && !present(args.systemImage)) return "create deviceProfile requires systemImage to provision a new AVD; omit deviceProfile when reusing an AVD";
    }
    if (args.backend === "ios-simulator") {
        if (args.udid !== undefined && !present(args.udid)) return "create udid must identify an existing simulator; omit it to provision a new simulator";
        if (present(args.udid) && (args.deviceType !== undefined || args.runtime !== undefined)) return "create udid reuses a simulator; omit deviceType and runtime, or omit udid to provision a new simulator";
        if (!present(args.udid) && (!present(args.deviceType) || !present(args.runtime))) return "create iOS Simulator requires deviceType and runtime, or udid to reuse an existing simulator; inspect inventory for installed choices";
    }
    return null;
}

export function normalizeCreateArgs(args) {
    return {
        ...args,
        ...(args.backend === "android-emulator" ? { createAvd: present(args.systemImage) } : {}),
        ...(args.backend === "ios-simulator" ? { createSimulator: !present(args.udid) } : {}),
    };
}

export function createInputSchema(existingSchema) {
    const properties = structuredClone(existingSchema.properties);
    properties.name.minLength = 1;
    properties.avdName.description = "With systemImage: optional new owner-prefixed AVD name. Without systemImage: reuse this existing AVD.";
    properties.udid.description = "Reuse an existing owner-scoped simulator. simulatorName must match its actual name (defaults to the owner/name-derived name). Omit udid to provision from deviceType and runtime.";
    properties.systemImage.description = "Installed Android system-images package identifier. Supplying it provisions a new AVD; omit only to reuse avdName. No automatic SDK download.";
    for (const key of ["avdName", "udid", "systemImage", "deviceType", "runtime"]) properties[key].minLength = 1;
    const common = Object.fromEntries(COMMON_FIELDS.filter(key => properties[key]).map(key => [key, properties[key]]));
    return {
        type: "object",
        properties: common,
        required: ["backend", "name"],
        oneOf: Object.entries(BACKEND_FIELDS).map(([backend, fields]) => {
            const branchProperties = Object.fromEntries(fields.map(key => [key, properties[key]]));
            if (branchProperties.provider) branchProperties.provider = { ...branchProperties.provider, enum: PROVIDERS[backend] };
            return {
                properties: { ...Object.fromEntries(Object.keys(common).map(key => [key, {}])), backend: { const: backend }, ...branchProperties },
                additionalProperties: false,
                ...(backend === "android-emulator" ? { oneOf: [{ required: ["avdName"], not: { anyOf: [{ required: ["systemImage"] }, { required: ["deviceProfile"] }] } }, { required: ["systemImage"] }] } : {}),
                ...(backend === "ios-simulator" ? { oneOf: [{ required: ["udid"], not: { anyOf: [{ required: ["deviceType"] }, { required: ["runtime"] }] } }, { required: ["deviceType", "runtime"], not: { required: ["udid"] } }] } : {}),
            };
        }),
    };
}
