import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";
import { windowsClipboardCommand } from "../clipboard-server.js";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10000 }).status === 0;
const text = "한글 日本語 😀 café C:\\사용자\\파일.txt\r\n'quoted' $literal `backtick\n";
const script = `$text = '${text.replaceAll("'", "''")}'; [Console]::Write($text)`;

describe("Windows clipboard Unicode transport", () => {
    it("keeps all source bytes ASCII without changing Unicode source or quoting", () => {
        const wire = windowsClipboardCommand(script);
        expect(wire).toMatch(/^[\x00-\x7f]+$/);
        const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wire)![1];
        expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
    });

    it.skipIf(!available)("round-trips exact text after a legacy output encoding on the persistent stdin path", () => {
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "-"], {
            input: `[Console]::OutputEncoding = [Text.Encoding]::ASCII\n${windowsClipboardCommand(script)}\n`,
            timeout: 10000, env: { ...process.env, TERM: "dumb" },
        });
        expect(result.status, result.stderr?.toString()).toBe(0);
        expect(result.stdout).toEqual(Buffer.from(text, "utf8"));
    });
});
