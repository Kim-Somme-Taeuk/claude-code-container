import { describe, expect, it } from "vitest";
import { proveHyperVLinuxGuiKeyboardFile } from "./hyper-v-gui-e2e.ts";

function reply(result: Record<string, unknown> = {}) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }] };
}

describe("Hyper-V Linux GUI keyboard proof", () => {
    it("uses the launcher after a shortcut opens no focused terminal", async () => {
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        let launcherOpened = false;
        const callTool = async (tool: string, args: Record<string, unknown>) => {
            calls.push({ tool, args });
            if (tool === "key" && args.key === "Alt+F2") launcherOpened = true;
            if (tool === "exec" && String(args.command).includes("ccc-terminal-focused")) return reply({ stdout: "ccc-terminal-focused" });
            if (tool === "exec") return reply({ stdout: launcherOpened ? "abc123" : "" });
            return reply();
        };
        await proveHyperVLinuxGuiKeyboardFile(callTool, { deviceId: "owned-vm" }, "abc123", async () => {});
        expect(calls.filter((call) => call.tool === "type").map((call) => call.args.text)).toEqual([
            "touch /tmp/cccguiabc123",
            "xfce4-terminal",
            "touch /tmp/cccguiabc123",
        ]);
        expect(calls.filter((call) => call.tool === "exec" && String(call.args.command).startsWith("test -f"))
            .every((call) => call.args.command === "test -f /tmp/cccguiabc123 && printf abc123")).toBe(true);
        expect(calls.filter((call) => call.tool === "exec" && String(call.args.command).includes("ccc-terminal-focused"))).toHaveLength(2);
        expect(calls.filter((call) => call.tool === "click").map((call) => [call.args.x, call.args.y]))
            .toEqual([[100, 100], [100, 100]]);
    });

    it("does not accept a terminal process or screen change without the guest file", async () => {
        const callTool = async (tool: string, args: Record<string, unknown>) =>
            tool === "exec" ? reply({ stdout: String(args.command).includes("ccc-terminal-focused") ? "ccc-terminal-focused" : "" }) : reply();
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-keyboard-guest-file-missing");
    });

    it("does not type the file command when the desktop has no focused terminal", async () => {
        const typed: string[] = [];
        const callTool = async (tool: string, args: Record<string, unknown>) => {
            if (tool === "type") typed.push(String(args.text));
            return tool === "exec" ? reply({ stdout: "" }) : reply();
        };
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-linux-terminal-not-focused");
        expect(typed).toEqual(["xfce4-terminal"]);
    });

    it("reports a missing X11 input tool as a bounded focus stage", async () => {
        const callTool = async (tool: string) =>
            tool === "exec" ? reply({ stdout: "ccc-focus-tool-missing" }) : reply();
        await expect(proveHyperVLinuxGuiKeyboardFile(callTool, {}, "abc123", async () => {}))
            .rejects.toThrow("hyper-v-gui-linux-terminal-not-focused[stage=tool-missing]");
    });
});
