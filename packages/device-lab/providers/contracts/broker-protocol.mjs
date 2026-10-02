// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 4 adds desktop drag/focus and real Sandbox/macOS cursor movement.
// Replace older daemons before routing the expanded desktop action surface.
export const DEVICE_BROKER_PROTOCOL_VERSION = 4;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
