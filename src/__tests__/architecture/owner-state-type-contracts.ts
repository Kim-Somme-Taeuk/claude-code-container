import { validateOwnerDevicePayload } from "../../../packages/device-lab/providers/domain/owner-device-payload.mjs";

export function checkOwnerStateContract(parsed: unknown): unknown[] | null {
    const result = validateOwnerDevicePayload(parsed, /safe/);
    if (result.kind === "valid") return result.devices;
    // @ts-expect-error Invalid outcomes never expose a usable device array.
    result.devices;
    return null;
}

// @ts-expect-error ID policy must be an explicit regular expression.
validateOwnerDevicePayload({}, "safe");
