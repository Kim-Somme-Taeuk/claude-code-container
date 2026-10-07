export function validateOwnerDevicePayload(parsed: unknown, idPattern: RegExp): OwnerDevicePayloadValidation;
export type OwnerDevicePayloadValidation = { kind: 'valid'; devices: unknown[] } | { kind: 'invalid' };
