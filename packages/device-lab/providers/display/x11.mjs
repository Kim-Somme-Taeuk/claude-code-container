import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run, runWithTimeout } from "../commands.mjs";
import { DISPLAY, ownerId } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { screenshotFileResult } from "../screenshot-file.mjs";
import { withTargetStatus } from "../status.mjs";
import { X11_WINDOW_LIST_COMMAND, parseX11WindowList } from "./window-list.mjs";

import { desktopPointValid, desktopDragValid, X11_DRAG_COMMAND } from "./desktop-input.mjs";

export function x11Available() {
    if (!existsSync("/usr/bin/xdotool") && !existsSync("/bin/xdotool")) return false;
    if (!existsSync("/usr/bin/scrot") && !existsSync("/bin/scrot")) return false;
    return true;
}

export function currentDisplayTarget() {
    return withTargetStatus({
        id: "x11-current-display",
        kind: "display",
        backend: "x11",
        creatable: false,
        lifecycle: "current",
        ownerId: ownerId(),
        display: DISPLAY,
        capabilities: [
            "device_status",
            "device_screenshot",
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_window_list",
            "device_drag",
            "device_focus_window",
            "display_screenshot",
            "display_click",
            "display_double_click",
            "display_key",
            "display_type",
            "display_scroll",
            "display_cursor_position",
        ],
        available: x11Available(),
    });
}

function cursorPositionPayload(stdout) {
    const fields = Object.fromEntries(String(stdout || "").trim().split(/\s+/)
        .map((part) => part.split(":"))
        .filter(([key, value]) => key && value !== undefined));
    return {
        x: Number.isFinite(Number(fields.x)) ? Number(fields.x) : null,
        y: Number.isFinite(Number(fields.y)) ? Number(fields.y) : null,
        screen: Number.isFinite(Number(fields.screen)) ? Number(fields.screen) : null,
        window: fields.window || null,
        raw: String(stdout || "").trim(),
        provider: "xdotool",
    };
}

export async function handleDisplayTool(name, args) {
    switch (name) {
        case "display_window_list": {
            const result = runWithTimeout("bash", ["-c", X11_WINDOW_LIST_COMMAND], Math.min(args.helperTimeoutMs || 30000, 30000), { maxBuffer: 1024 * 1024 });
            if (result.status !== 0) return fail(result);
            try { return jsonResult(parseX11WindowList(result.stdout)); }
            catch { return textResult(false, "window-list-invalid-result"); }
        }
        case "display_drag": {
            if (!desktopDragValid(args)) return textResult(false, "invalid-drag-arguments");
            const r = runWithTimeout("bash", ["-c", X11_DRAG_COMMAND, "ccc-drag", ...[args.x1, args.y1, args.x2, args.y2, args.durationMs ?? 700].map(String)], 15000);
            return r.status === 0 ? jsonResult({ ok: true }) : fail(r);
        }
        case "display_focus_window": {
            if (typeof args.handle !== "string" || !/^[1-9][0-9]{0,19}$/.test(args.handle)) return textResult(false, "invalid-window-handle");
            const r = runWithTimeout("xdotool", ["windowactivate", "--sync", args.handle], 5000);
            if (r.status !== 0) return fail(r);
            const active = runWithTimeout("xdotool", ["getactivewindow"], 5000);
            if (active.status !== 0) return fail(active);
            return active.stdout.trim() === args.handle ? jsonResult({ ok: true }) : textResult(false, "window-focus-denied");
        }
        case "display_move": {
            if (!desktopPointValid(args.x, args.y)) return textResult(false, "invalid-pointer-coordinates");
            const r = run("xdotool", ["mousemove", String(args.x), String(args.y)]);
            return r.status === 0 ? jsonResult({ ok: true }) : fail(r);
        }
        case "display_current":
            return jsonResult(currentDisplayTarget());

        case "display_screenshot": {
            const tempRoot = mkdtempSync(join(tmpdir(), "ccc-x11-screenshot-"));
            const ssPath = join(tempRoot, "screenshot.png");
            try {
                const r = runWithTimeout("scrot", ["-p", "-o", ssPath], 30_000);
                if (r.status !== 0) return fail(r);
                return screenshotFileResult(ssPath, "x11-screenshot");
            } finally {
                rmSync(tempRoot, { recursive: true, force: true });
            }
        }

        case "display_click": {
            const { x, y, button = "left" } = args;
            const buttonId = button === "right" ? "3" : "1";
            const r = run("xdotool", ["mousemove", String(x), String(y), "click", buttonId]);
            return r.status === 0 ? jsonResult({ clicked: { x, y, button }, provider: "xdotool", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "display_double_click": {
            const { x, y, button = "left" } = args;
            const buttonId = button === "right" ? "3" : "1";
            const r = run("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", "2", buttonId]);
            return r.status === 0 ? jsonResult({ doubleClicked: { x, y, button }, provider: "xdotool", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "display_key": {
            const { key } = args;
            const r = run("xdotool", ["key", "--", key]);
            return r.status === 0 ? jsonResult({ key, provider: "xdotool", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "display_type": {
            const { text } = args;
            const r = run("xdotool", ["type", "--clearmodifiers", "--", text]);
            return r.status === 0 ? jsonResult({ typed: true, length: String(text || "").length, provider: "xdotool", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "display_scroll": {
            const { x, y, direction, amount = 3 } = args;
            const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
            const button = buttonMap[direction];
            if (!button) return textResult(false, `Unknown scroll direction: ${direction}`);
            const r = run("xdotool", [
                "mousemove", String(x), String(y),
                "click", "--repeat", String(amount), String(button),
            ]);
            return r.status === 0 ? jsonResult({ scrolled: { x, y, direction, amount }, provider: "xdotool", stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "display_cursor_position": {
            const r = run("xdotool", ["getmouselocation"]);
            return r.status === 0 ? jsonResult(cursorPositionPayload(r.stdout)) : fail(r);
        }

        default:
            return undefined;
    }
}
