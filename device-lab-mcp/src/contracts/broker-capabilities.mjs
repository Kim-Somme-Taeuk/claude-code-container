// Host broker capability matching, shared by every consumer that decides whether a running broker
// is compatible: the in-container MCP client (broker.mjs), the host CLI (src/device-lab-broker.ts),
// and the level-3 real-test attestation.
//
// Capabilities are either unversioned ("http-owner-rpc") or versioned families
// ("hyper-v-setup-network-v10": family "hyper-v-setup-network", version 10). A family bump means
// "this broker also carries fix/contract N", so a broker advertising family-vM satisfies a
// requirement for family-vN whenever M >= N. Exact matching made every bump break every existing
// container whose image predated the host install: a newer host broker advertising -v10 was
// rejected by an older MCP that required -v9, although it carried everything -v9 promised.
//
// An OLDER broker (M < N) still does not satisfy the requirement, so the host CLI keeps replacing
// stale brokers. A change that is not backward compatible for older clients must therefore not be
// shipped as a family bump: it needs a new family name, or the broker must keep serving the older
// contract alongside the new one.

const VERSIONED_CAPABILITY = /^(.+)-v(\d+)$/;

export function parseBrokerCapability(capability) {
    const text = String(capability);
    const match = VERSIONED_CAPABILITY.exec(text);
    const version = match ? Number(match[2]) : NaN;
    return match && Number.isSafeInteger(version)
        ? { family: match[1], version }
        : { family: text, version: null };
}

function implementedCapabilityIndex(implemented) {
    const exact = new Set();
    const newestByFamily = new Map();
    for (const capability of Array.isArray(implemented) ? implemented : []) {
        const text = String(capability);
        exact.add(text);
        const parsed = parseBrokerCapability(text);
        if (parsed.version === null) continue;
        const newest = newestByFamily.get(parsed.family);
        if (newest === undefined || parsed.version > newest) newestByFamily.set(parsed.family, parsed.version);
    }
    return { exact, newestByFamily };
}

function satisfiedBy(index, required) {
    const text = String(required);
    if (index.exact.has(text)) return true;
    const parsed = parseBrokerCapability(text);
    if (parsed.version === null) return false;
    const newest = index.newestByFamily.get(parsed.family);
    return newest !== undefined && newest >= parsed.version;
}

export function brokerCapabilitySatisfied(required, implemented) {
    return satisfiedBy(implementedCapabilityIndex(implemented), required);
}

export function missingBrokerCapabilities(required, implemented) {
    const index = implementedCapabilityIndex(implemented);
    return (Array.isArray(required) ? required : [])
        .map(String)
        .filter((capability) => !satisfiedBy(index, capability));
}
