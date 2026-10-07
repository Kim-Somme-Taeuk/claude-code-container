import { describe, expect, it } from "vitest";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";
import { MCP_ERROR_TEXT_LIMIT_BYTES } from "@ccc/device-lab/providers/responses.mjs";
const raw = (value: any, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const parse = (value: any) => JSON.parse(value.content[0].text);
describe("compact action diagnostics", () => {
    it.each([false, true])("retains failed stdout with MCP-only error=%s", mcpOnly => {
        const value = { ...(mcpOnly ? {} : { ok: false, status: 1, error: "android-network-command-failed" }), stdout: "Unknown command: wifi", stderr: "" };
        const result = actionResult("set_network", "mobile_set_network", raw(value, mcpOnly));
        expect(result.isError).toBe(true);
        expect(parse(result).stdout).toBe("Unknown command: wifi");
    });
    it("keeps failure diagnostics inside known envelopes", () => {
        const result = actionResult("set_network", "mobile_set_network", raw({ result: { status: 1, stdout: "denied", stderr: "" } }));
        expect(result.isError).toBe(true);
        expect(parse(result).result.stdout).toBe("denied");
    });
    it("retains individual battery warnings and stdout with their command index", () => {
        const value = { battery: { level: 50 }, results: [{ status: 0, stdout: "", stderr: "" }, { status: 0, stdout: "override ignored", stderr: "warning" }] };
        const result = actionResult("set_battery", "mobile_set_battery", raw(value));
        expect(result.isError).toBe(false);
        expect(parse(result)).toEqual({ results: [{ index: 1, warning: "warning", stdout: "override ignored" }] });
        expect(parse(actionResult("set_battery", "mobile_set_battery", raw(value), { detail: true }))).toEqual(value);
    });
    it("does not report success for a failed battery subcommand", () => {
        const result = actionResult("set_battery", "mobile_set_battery", raw({ results: [{ status: 1, stdout: "failure" }] }));
        expect(result.isError).toBe(true);
        expect(parse(result).results[0]).toMatchObject({ index: 0, stdout: "failure", status: 1 });
    });
    it("still collapses clean battery success to ok", () => {
        const result = actionResult("set_battery", "mobile_set_battery", raw({ results: [{ status: 0, stdout: "", stderr: "" }] }));
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });
    it("bounds oversized failed diagnostics", () => {
        const result = actionResult("set_network", "mobile_set_network", raw({ stdout: "denied ".repeat(100000) }, true));
        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(parse(result).diagnosticTruncated).toBe(true);
        expect(parse(result).diagnosticExcerpt).toContain("denied");
    });
    it("bounds oversized successful battery warnings without marking failure", () => {
        const result = actionResult("set_battery", "mobile_set_battery", raw({ results: [{ status: 0, stderr: "warning ".repeat(100000) }] }));
        expect(result.isError).toBe(false);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(parse(result).diagnosticTruncated).toBe(true);
        expect(parse(result)).not.toHaveProperty("ok", false);
        expect(parse(result)).not.toHaveProperty("error");
        expect(parse(result).diagnosticExcerpt).toContain("warning");
    });
    it("preserves recovery fields after an oversized early diagnostic", () => {
        const result = actionResult("click", "device_click", raw({ error: "stop-failed", cause: "x".repeat(70000), remedy: "Retry stop before deletion", cleanup: { stopped: false }, scrubContainmentFailed: true }, true));
        expect(parse(result)).toMatchObject({ error: "stop-failed", remedy: "Retry stop before deletion", cleanup: { stopped: false }, scrubContainmentFailed: true });
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
    });
    it.each(["exec", "ui"])("does not interpret opaque %s result arrays", name => {
        const value = { results: [{ status: 1, stdout: "application data", stderr: "not a warning" }] };
        const result = actionResult(name, name === "exec" ? "device_exec" : "device_accessibility_snapshot", raw(value));
        expect(result.isError).toBe(false);
        expect(parse(result)).toEqual(value);
    });
});
