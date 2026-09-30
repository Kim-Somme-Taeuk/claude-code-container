import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
    DEVICE_LAB_OUTPUT_CONTRACTS,
    hasDeviceLabOutputContract,
    validateDeviceLabToolOutput,
} from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

function schemaShape(value: any): any {
    if (Array.isArray(value)) return value.map(schemaShape);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).filter(key => key !== "description").sort().map(key => [key, schemaShape(value[key])]));
    return value;
}

describe("canonical public input schemas", () => {
    it("preserves advertised input shapes while removing compatibility-only acceptance", () => {
        expect(createHash("sha256").update(JSON.stringify(schemaShape(TOOLS))).digest("hex"))
            .toBe("2f58e206309a13ae21c4b09c03dc6b6db5f9a182c832e568ec001b152b6b3f84");
    });
});

describe("device-lab public output contracts", () => {
    it("maps lifecycle and mobile session tools to explicit contracts", () => {
        expect(DEVICE_LAB_OUTPUT_CONTRACTS).toEqual(expect.objectContaining({
            device_create: "lifecycle-device-v1",
            device_status: "lifecycle-device-v1",
            device_start: "lifecycle-device-v1",
            device_stop: "lifecycle-device-v1",
            device_delete: "lifecycle-delete-v1",
            mobile_session_status: "mobile-session-status-v1",
        }));
        expect(hasDeviceLabOutputContract("device_start")).toBe(true);
        expect(hasDeviceLabOutputContract("mobile_tap")).toBe(true);
        expect(hasDeviceLabOutputContract("not_a_public_tool")).toBe(false);
    });

    it("covers every advertised tool exactly once", () => {
        const accepted = TOOLS.map((tool: { name: string }) => tool.name).sort();
        const contracted = Object.keys(DEVICE_LAB_OUTPUT_CONTRACTS).sort();
        expect(contracted).toEqual(accepted);
        expect(contracted).toHaveLength(87);
        expect(TOOLS).toHaveLength(87);
        expect(TOOLS.every((tool: { name: string }) => contracted.includes(tool.name))).toBe(true);
    });

    it("returns typed lifecycle and session payloads", () => {
        const lifecycle = validateDeviceLabToolOutput("device_start", {
            device: { id: "ios-contract", status: "running" },
        });
        const session = validateDeviceLabToolOutput("mobile_session_status", {
            deviceId: "ios-contract",
            session: null,
        });

        expect(lifecycle.device.id).toBe("ios-contract");
        expect(session.deviceId).toBe("ios-contract");
    });

    it("reports the tool and missing field instead of leaking undefined access errors", () => {
        expect(() => validateDeviceLabToolOutput("device_status", { routedBy: "broker" }))
            .toThrow("device_status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("mobile_session_status", { session: null }))
            .toThrow("mobile_session_status response contract violation: required deviceId field is missing");
        expect(() => validateDeviceLabToolOutput("device_start", { ok: false, error: "provider-command-failed" }))
            .toThrow("device_start response contract violation: operation failed (provider-command-failed)");
    });
});
