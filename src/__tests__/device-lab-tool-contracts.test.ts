import { describe, expect, it } from "vitest";
import {
    DEVICE_LAB_OUTPUT_CONTRACTS,
    hasDeviceLabOutputContract,
    validateDeviceLabToolOutput,
} from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

describe("canonical public input schemas", () => {
    it("exposes only unique action names with explicit targets", () => {
        const names = TOOLS.map(tool => tool.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every(name => !/^(device|mobile|display)_/.test(name))).toBe(true);
        for (const name of ["click", "double_click", "move", "type", "key", "screenshot", "status"]) {
            expect(TOOLS.find(tool => tool.name === name)?.inputSchema.required).toContain("deviceId");
        }
    });
});

describe("device-lab public output contracts", () => {
    it("maps lifecycle and mobile session tools to explicit contracts", () => {
        expect(DEVICE_LAB_OUTPUT_CONTRACTS).toEqual(expect.objectContaining({
            create: "lifecycle-device-v1",
            status: "lifecycle-device-v1",
            start: "lifecycle-device-v1",
            stop: "lifecycle-device-v1",
            delete: "lifecycle-delete-v1",
            snapshot: "snapshot-group-v1",
        }));
        expect(hasDeviceLabOutputContract("start")).toBe(true);
        expect(hasDeviceLabOutputContract("click")).toBe(true);
        expect(hasDeviceLabOutputContract("not_a_public_tool")).toBe(false);
    });

    it("validates both UI forms and rejects arbitrary empty data", () => {
        expect(validateDeviceLabToolOutput("ui", { source: "<hierarchy/>" })).toEqual({ source: "<hierarchy/>" });
        const desktop = { accessibility: { root: { name: "Desktop" }, nodeCount: 1 } };
        expect(validateDeviceLabToolOutput("ui", desktop)).toEqual(desktop);
        expect(() => validateDeviceLabToolOutput("ui", {})).toThrow("required mobile source or desktop accessibility tree");
    });
    it("covers every advertised tool exactly once", () => {
        const accepted = TOOLS.map((tool: { name: string }) => tool.name).sort();
        const contracted = Object.keys(DEVICE_LAB_OUTPUT_CONTRACTS).sort();
        expect(contracted).toEqual(accepted);
        expect(contracted).toHaveLength(TOOLS.length);
        expect(TOOLS.every((tool: { name: string }) => contracted.includes(tool.name))).toBe(true);
    });

    it("returns typed lifecycle and session payloads", () => {
        const lifecycle = validateDeviceLabToolOutput("start", {
            device: { id: "ios-contract", status: "running" },
        });
        const session = validateDeviceLabToolOutput("status", {
            device: { id: "ios-contract" },
            automation: { session: null },
        });

        expect(lifecycle.device.id).toBe("ios-contract");
        expect(session.device.id).toBe("ios-contract");
    });

    it("reports the tool and missing field instead of leaking undefined access errors", () => {
        expect(() => validateDeviceLabToolOutput("status", { routedBy: "broker" }))
            .toThrow("status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("status", { session: null }))
            .toThrow("status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("start", { ok: false, error: "provider-command-failed" }))
            .toThrow("start response contract violation: operation failed (provider-command-failed)");
    });
});
