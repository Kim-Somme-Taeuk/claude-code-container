import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseToolPayload } from "./device-lab-mcp-client.ts";
import { unfilteredHyperVConsolePixels } from "./hyper-v-console-host.ts";

const GUI_TOOLS = ["device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position"] as const;

function accepted(result: any, tool: string): any {
    const value = parseToolPayload(result);
    const diagnostic = `hyper-v-gui-${tool.replaceAll("_", "-")}-failed`;
    assert.notEqual(result?.isError, true, diagnostic);
    assert.notEqual(value?.ok, false, diagnostic);
    return value?.result || value;
}

function screenshot(result: any, incarnationId: string): Buffer {
    assert.notEqual(result?.isError, true, "hyper-v-gui-screenshot-failed");
    const image = result?.content?.find((item: any) => item?.type === "image" && item?.mimeType === "image/png");
    const text = result?.content?.find((item: any) => item?.type === "text")?.text;
    assert.ok(image && typeof image.data === "string", "hyper-v-gui-screenshot-png-missing");
    let metadata: any;
    try { metadata = JSON.parse(String(text || "{}")); }
    catch { throw new Error("hyper-v-gui-screenshot-metadata-invalid"); }
    assert.equal(metadata.width, 640, "hyper-v-gui-screenshot-width-invalid");
    assert.equal(metadata.height, 480, "hyper-v-gui-screenshot-height-invalid");
    assert.ok(metadata.incarnationId === incarnationId, "hyper-v-gui-screenshot-incarnation-invalid");
    const png = Buffer.from(image.data, "base64");
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "hyper-v-gui-screenshot-png-invalid");
    return png;
}

export function changedHyperVGuiViewportBytes(beforePng: Buffer, afterPng: Buffer): number {
    let before: Buffer;
    let after: Buffer;
    try {
        before = unfilteredHyperVConsolePixels(beforePng);
        after = unfilteredHyperVConsolePixels(afterPng);
    } catch {
        throw new Error("hyper-v-gui-screenshot-pixel-format-invalid");
    }
    assert.ok(before.length === after.length, "hyper-v-gui-screenshot-pixel-format-changed");
    const channels = before.length / (640 * 480);
    let changed = 0;
    // Compare the app's central document/terminal viewport. Exclude taskbars, title
    // chrome and the cursor at the wheel target; a blinking caret cannot clear this bar.
    for (let y = 100; y < 400; y++) {
        for (let x = 80; x < 560; x++) {
            if (x >= 304 && x <= 336 && y >= 224 && y <= 256) continue;
            const offset = (y * 640 + x) * channels;
            for (let channel = 0; channel < channels; channel++) {
                if (before[offset + channel] !== after[offset + channel]) changed++;
            }
        }
    }
    return changed;
}

export async function proveHyperVLinuxGuiKeyboardFile(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
    nonce: string,
    wait: (milliseconds: number) => Promise<unknown> = delay,
): Promise<void> {
    const path = `/tmp/cccgui${nonce}`;
    const fileExists = async (attempts: number): Promise<boolean> => {
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const result = accepted(await callTool("device_exec", { ...direct, command: `test -f ${path} && printf ${nonce}` }), "device_exec");
                if (String(result.stdout || "").trim() === nonce) return true;
            } catch { /* keyboard input may still be reaching the guest */ }
            await wait(500);
        }
        return false;
    };
    const typeFileCommand = async () => {
        accepted(await callTool("device_type", { ...direct, text: `touch ${path}` }), "device_type");
        accepted(await callTool("device_key", { ...direct, key: "Enter" }), "device_key");
    };
    const focusTerminal = async (): Promise<{ focused: boolean; stage: string }> => {
        const command = [
            "set -uo pipefail",
            "if ! command -v xdotool >/dev/null; then printf ccc-focus-tool-missing; exit 0; fi",
            "xd=(sudo -n -u ccc-desktop env DISPLAY=:0 XAUTHORITY=/home/ccc-desktop/.Xauthority xdotool)",
            "if ! \"${xd[@]}\" getdisplaygeometry >/dev/null 2>&1; then printf ccc-focus-display-unavailable; exit 0; fi",
            "window=$(\"${xd[@]}\" search --onlyvisible --class xfce4-terminal 2>/dev/null | tail -n 1)",
            "if test -z \"$window\"; then printf ccc-focus-window-missing; exit 0; fi",
            "if ! timeout 4s \"${xd[@]}\" windowactivate --sync \"$window\" >/dev/null 2>&1; then printf ccc-focus-activate-failed; exit 0; fi",
            "active=$(\"${xd[@]}\" getactivewindow 2>/dev/null)",
            "if test \"$active\" != \"$window\"; then printf ccc-focus-active-mismatch; exit 0; fi",
            "printf ccc-terminal-focused",
        ].join("\n");
        let stage = "rpc-failed";
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const result = accepted(await callTool("device_exec", { ...direct, command, helperTimeoutMs: 5000 }), "device_exec");
                const marker = String(result.stdout || "").trim();
                if (marker === "ccc-terminal-focused") return { focused: true, stage: "focused" };
                if (/^ccc-focus-(?:tool-missing|display-unavailable|window-missing|activate-failed|active-mismatch)$/.test(marker)) {
                    stage = marker.slice("ccc-focus-".length);
                }
            } catch { /* window manager may still be mapping the terminal */ }
            await wait(500);
        }
        return { focused: false, stage };
    };

    accepted(await callTool("device_key", { ...direct, key: "Ctrl+Alt+T" }), "device_key");
    await wait(1500);
    // The XFCE launcher can remain above an open terminal. The disposable
    // desktop places the terminal's text viewport in this upper-left region.
    accepted(await callTool("device_click", { ...direct, x: 100, y: 100 }), "device_click");
    if ((await focusTerminal()).focused) {
        await typeFileCommand();
        if (await fileExists(3)) return;
    }

    // A terminal process or a changed frame does not prove keyboard focus. Try
    // the XFCE application launcher and accept only the guest file as proof.
    accepted(await callTool("device_key", { ...direct, key: "Alt+F2" }), "device_key");
    await wait(800);
    accepted(await callTool("device_type", { ...direct, text: "xfce4-terminal" }), "device_type");
    accepted(await callTool("device_key", { ...direct, key: "Enter" }), "device_key");
    await wait(1500);
    accepted(await callTool("device_click", { ...direct, x: 100, y: 100 }), "device_click");
    const terminal = await focusTerminal();
    assert.ok(terminal.focused, `hyper-v-gui-linux-terminal-not-focused[stage=${terminal.stage}]`);
    await typeFileCommand();
    assert.ok(await fileExists(8), "hyper-v-gui-keyboard-guest-file-missing");
}

export async function runHyperVGuiE2E(
    callTool: (tool: string, args: Record<string, unknown>) => Promise<any>,
    direct: Record<string, unknown>,
    guest: "windows" | "linux",
): Promise<{ tools: readonly string[]; visibleChange: boolean }> {
    const nonce = randomBytes(6).toString("hex");
    const first = screenshot(await callTool("device_screenshot", direct), String(direct.incarnationId));
    if (guest === "windows") {
        accepted(await callTool("device_key", { ...direct, key: "Win+R" }), "device_key");
        await delay(800);
        accepted(await callTool("device_type", { ...direct, text: `cmd /c echo ${nonce} > "%PUBLIC%\\Documents\\ccc-gui-${nonce}.txt"` }), "device_type");
        accepted(await callTool("device_key", { ...direct, key: "Enter" }), "device_key");
    } else {
        await proveHyperVLinuxGuiKeyboardFile(callTool, direct, nonce);
    }
    const file = guest === "windows" ? `C:\\Users\\Public\\Documents\\ccc-gui-${nonce}.txt` : `/tmp/cccgui${nonce}`;
    if (guest === "windows") {
        let observed = "";
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                const execution = accepted(await callTool("device_exec", { ...direct, command: `Get-Content -LiteralPath '${file}'` }), "device_exec");
                observed = String(execution.stdout || "").trim();
                if (observed === nonce) break;
            } catch { /* the input may still be reaching the guest */ }
            await delay(1000);
        }
        assert.ok(observed === nonce, "hyper-v-gui-keyboard-guest-file-missing");
    }
    if (guest === "windows") {
        // Keep a visible editor open: the earlier `cmd /c` Run action closes immediately,
        // so its successful guest-file proof alone cannot prove a changed final frame.
        accepted(await callTool("device_key", { ...direct, key: "Win+R" }), "device_key");
        await delay(800);
        accepted(await callTool("device_type", { ...direct, text: "notepad" }), "device_type");
        accepted(await callTool("device_key", { ...direct, key: "Enter" }), "device_key");
        await delay(1500);
        accepted(await callTool("device_key", { ...direct, key: "Win+Up" }), "device_key");
        // The lines must be visually distinct: a wheel movement over nearly identical
        // line numbers changes too few pixels to prove a real viewport scroll.
        accepted(await callTool("device_type", { ...direct, text: Array.from({ length: 40 }, (_, index) => `CCC ${index.toString().padStart(2, "0")} ${String.fromCharCode(65 + index % 26).repeat(28)}\r\n`).join("") }), "device_type");
    } else {
        accepted(await callTool("device_type", { ...direct, text: "awk 'BEGIN {for(n=0;n<200;n++){c=sprintf(\"%c\",65+n%26);s=\"\";for(i=0;i<60;i++)s=s c;print n,s}}'" }), "device_type");
        accepted(await callTool("device_key", { ...direct, key: "Enter" }), "device_key");
    }
    const rejected = await callTool("device_click", { ...direct, x: 640, y: 240 });
    assert.ok(/hyper-v-console-pixel-invalid/.test(JSON.stringify(rejected)), "hyper-v-gui-out-of-bounds-click-accepted");
    accepted(await callTool("device_cursor_position", { ...direct, x: 10, y: 10 }), "device_cursor_position");
    const movedAway = accepted(await callTool("device_cursor_position", direct), "device_cursor_position");
    assert.ok(Math.abs(Number(movedAway.x) - 10) <= 2 && Math.abs(Number(movedAway.y) - 10) <= 2,
        "hyper-v-gui-cursor-first-position-failed");
    accepted(await callTool("device_cursor_position", { ...direct, x: 320, y: 240 }), "device_cursor_position");
    const cursor = accepted(await callTool("device_cursor_position", direct), "device_cursor_position");
    assert.ok(Math.abs(Number(cursor.x) - 320) <= 2 && Math.abs(Number(cursor.y) - 240) <= 2,
        "hyper-v-gui-cursor-second-position-failed");
    accepted(await callTool("device_click", { ...direct, x: 320, y: 240 }), "device_click");
    accepted(await callTool("device_double_click", { ...direct, x: 320, y: 240 }), "device_double_click");
    await delay(700);
    const beforeScroll = screenshot(await callTool("device_screenshot", direct), String(direct.incarnationId));
    accepted(await callTool("device_scroll", { ...direct, x: 320, y: 240, direction: "up", amount: 10 }), "device_scroll");
    let last = beforeScroll;
    let scrollChangedBytes = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
        await delay(700);
        last = screenshot(await callTool("device_screenshot", direct), String(direct.incarnationId));
        scrollChangedBytes = changedHyperVGuiViewportBytes(beforeScroll, last);
        if (scrollChangedBytes >= 3000) break;
    }
    assert.ok(scrollChangedBytes >= 3000,
        `hyper-v-gui-scroll-no-visible-effect[changed=${scrollChangedBytes}]`);
    assert.ok(changedHyperVGuiViewportBytes(first, last) >= 3000,
        "hyper-v-gui-keyboard-no-visible-effect");
    return { tools: GUI_TOOLS, visibleChange: true };
}
