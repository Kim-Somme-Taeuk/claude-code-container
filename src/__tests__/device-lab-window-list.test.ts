import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { X11_WINDOW_LIST_COMMAND, parseX11WindowList } from "@ccc/device-lab/providers/display/window-list.mjs";

describe("X11 window listing", () => {
    function execute(mode: string) {
        const root = mkdtempSync(join(tmpdir(), "window-list-test-"));
        writeFileSync(join(root, "xdotool"), `#!/bin/sh
case "$1" in
 getdisplaygeometry) [ "$MODE" != unavailable ] || exit 1;;
 search) case "$MODE" in empty) exit 1;; broken) echo connection-lost >&2; exit 1;; many|long) seq 1 129;; *) printf '42\\n43\\n';; esac;;
 getwindowname) if [ "$MODE" = long ]; then head -c 4096 /dev/zero | tr '\\0' x; else printf '한글\\tline\\ntitle %s\\n' "$2"; fi;;
 getwindowpid) [ "$2" != 43 ] || exit 1; printf 123;;
esac`, { mode: 0o755 });
        try { return spawnSync("bash", ["-c", X11_WINDOW_LIST_COMMAND], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MODE: mode } }); }
        finally { rmSync(root, { recursive: true, force: true }); }
    }
    it.skipIf(process.platform === "win32")("executes enumeration preserving Unicode, tabs and embedded newlines", () => {
        const result = execute("normal");
        expect(result.status, result.stderr).toBe(0);
        expect(parseX11WindowList(result.stdout)).toEqual({ windows: [
            { handle: "42", title: "한글\tline\ntitle 42", processId: 123 },
            { handle: "43", title: "한글\tline\ntitle 43" },
        ] });
    });
    it.skipIf(process.platform === "win32")("distinguishes empty success from display/query failures", () => {
        const empty = execute("empty");
        expect(empty.status).toBe(0);
        expect(parseX11WindowList(empty.stdout)).toEqual({ windows: [] });
        for (const mode of ["unavailable", "broken"]) expect(execute(mode).status).not.toBe(0);
    });
    it.skipIf(process.platform === "win32")("bounds results and explicitly reports truncation", () => {
        const result = execute("many");
        expect(result.status).toBe(0);
        const parsed = parseX11WindowList(result.stdout);
        expect(parsed.windows).toHaveLength(128);
        expect(parsed.truncated).toBe(true);
    });
    it.skipIf(process.platform === "win32")("budgets base64 framing below the Hyper-V SSH 32KiB transport limit", () => {
        const result = execute("long");
        expect(result.status).toBe(0);
        expect(Buffer.byteLength(result.stdout)).toBeLessThan(24576);
        const parsed = parseX11WindowList(result.stdout);
        expect(parsed.truncated).toBe(true);
        expect(parsed.windows.length).toBeGreaterThan(0);
        expect(parsed.windows.length).toBeLessThan(128);
    });
    it.each(["bad", "1\t\t%%%", "1;exit\t\tYQ==", "TRUNCATED\n1\t\tYQ==", "x".repeat(1048577)])("rejects malformed/oversized payload %#", value => {
        expect(() => parseX11WindowList(value)).toThrow("window-list-invalid-result");
    });
});
