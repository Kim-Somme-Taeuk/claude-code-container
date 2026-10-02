import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";

describe("closed public arguments", () => {
    it.each(TOOLS)("closes the $name advertised schema", tool => {
        expect(tool.inputSchema.additionalProperties).toBe(false);
    });
    it("rejects a misspelled clipboard write instead of selecting read", () => {
        expect(toolInputError("clipboard", { deviceId: "phone", action: "set", value: "secret" })).toBe("clipboard does not support action");
        expect(toolInputError("clipboard", { deviceId: "phone", value: "secret" })).toBe("clipboard does not support value");
        expect(toolInputError("clipboard", { deviceId: "phone", text: "" })).toBeNull();
    });
    it.each([
        ["click", { deviceId: "phone", x: 1, y: 2 }],
        ["list_files", { deviceId: "vm", path: "/" }],
        ["start", { deviceId: "vm" }],
        ["run_flow", { steps: [] }],
    ] as const)("rejects unknown %s fields and preserves internal routing", (name, args) => {
        expect(toolInputError(name, { ...args, typo: true })).toBe(`${name} does not support typo`);
        expect(toolInputError(name, { ...args, implicitBroker: false, autolaunch: false })).toBeNull();
    });
});
