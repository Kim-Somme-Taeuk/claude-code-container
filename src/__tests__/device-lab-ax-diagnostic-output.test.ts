import { describe, expect, it } from "vitest";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";

const raw = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const payload = (result: any) => JSON.parse(result.content[0].text);

describe("public AX diagnostic preservation", () => {
    it("keeps the exact device and backend alternatives needed to recover an ambiguous action", () => {
        const failure = { ok: false, error: "ambiguous-device-backend", deviceId: "phone", matches: ["android-emulator", "ios-simulator"], retryable: false };
        const result = actionResult("click", "device_click", raw(failure));
        expect(result.isError).toBe(true);
        expect(payload(result)).toEqual({ error: failure.error, deviceId: "phone", matches: failure.matches, retryable: false });
    });

    it("names the public rejected action and retains target context for nested failures", () => {
        const result = actionResult("click", "device_click", raw({ deviceId: "vm", backend: "linux-vm", result: {
            ok: false, error: "device-tool-unsupported", tool: "device_click", actualBackend: "linux-vm", retryable: false,
        } }));
        expect(result.isError).toBe(true);
        expect(payload(result)).toEqual({ deviceId: "vm", backend: "linux-vm", result: {
            error: "device-tool-unsupported", tool: "click", actualBackend: "linux-vm", retryable: false,
        } });
    });

    it("retains failed boot and containment evidence when listing a running VM", () => {
        const result = actionResult("devices", "device_list", raw({ devices: [{
            id: "vm", backend: "windows-vm", provider: "hyper-v", status: "running", bootReady: false,
            lastBootCheck: { ready: false, error: "hyper-v-guest-not-ready", scrubContainmentFailed: true, attempts: 25, diagnostic: { large: "history" } },
        }] }));
        expect(payload(result)).toEqual([{
            deviceId: "vm", backend: "windows-vm", provider: "hyper-v", state: "running", bootReady: false,
            lastBootCheck: { ready: false, error: "hyper-v-guest-not-ready", scrubContainmentFailed: true },
        }]);
    });

    it("keeps successful boot metadata out of ordinary device summaries", () => {
        expect(payload(actionResult("devices", "device_list", raw({ devices: [{ id: "ready", status: "running", bootReady: true,
            lastBootCheck: { ready: true, attempts: 3 }, readiness: { state: "ready" } }] }))))
            .toEqual([{ deviceId: "ready", state: "running" }]);
    });

    it("preserves unique stdout through the final public action projection", () => {
        const result = actionResult("click", "device_click", raw({
            clicked: { x: 1, y: 2 }, provider: "windows-helper", status: 0,
            stdout: "Unique provider warning", response: { ok: true, clicked: { x: 1, y: 2 } },
        }));
        expect(result.isError).toBe(false);
        expect(payload(result)).toEqual({ stdout: "Unique provider warning" });
    });

    it("still removes ordinary structured helper echoes", () => {
        const response = { ok: true, clicked: { x: 1, y: 2 } };
        const result = actionResult("click", "device_click", raw({ ...response, response, stdout: JSON.stringify(response), status: 0, stderr: "" }));
        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    });

    it("recognizes the macOS key helper's equivalent modifier representation without hiding warnings", () => {
        const echo = { ok: true, key: { keyCode: 0, modifiers: "command" }, provider: "macos-helper" };
        const value = { provider: "ssh-macos-helper", key: { key: "Command+A", keyCode: 0, modifiers: ["command"] }, stdout: JSON.stringify(echo) };
        expect(actionResult("key", "device_key", raw(value)).content).toEqual([{ type: "text", text: "ok" }]);
        const stdout = JSON.stringify({ ...echo, warning: "Input may be incomplete" });
        expect(payload(actionResult("key", "device_key", raw({ ...value, stdout })))).toEqual({ stdout });
    });

    it("bounds large successful stdout diagnostics without turning them into failures", () => {
        const result = actionResult("click", "device_click", raw({ stdout: "warning ".repeat(20000) }));
        expect(result.isError).toBe(false);
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(65536);
        expect(payload(result)).toMatchObject({ diagnosticTruncated: true });
        expect(payload(result).diagnosticExcerpt).toContain("warning");
    });
});
