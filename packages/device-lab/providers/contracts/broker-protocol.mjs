// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 3 adds airplaneMode to the combined network command; old daemons must
// be replaced so they cannot silently ignore part of a requested network change.
export const DEVICE_BROKER_PROTOCOL_VERSION = 3;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
