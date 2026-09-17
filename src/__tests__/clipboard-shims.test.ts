import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const shimsDir = fileURLToPath(new URL("../../scripts/clipboard-shims/", import.meta.url));
const shims = [
    { name: "xclip", args: ["-selection", "clipboard", "-o"] },
    { name: "xsel", args: ["--clipboard", "--output"] },
    { name: "wl-paste", args: [] },
    { name: "wl-copy", args: [] },
    { name: "pbpaste", args: [] },
];

describe.skipIf(process.platform === "win32").each(shims)("$name mounted clipboard token", ({ name, args }) => {
    it.each(["readable", "unreadable", "missing", "a directory"])("preserves the correct token when the port file is %s", (state) => {
        const directory = mkdtempSync(join(tmpdir(), "ccc-clipboard-shim-"));
        const portFile = join(directory, "clipboard.port");
        const captureFile = join(directory, "authorization");
        const shimFile = join(directory, name);
        // Root can read mode-000 files, so run its fixture as an unprivileged UID.
        const identity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
        if (identity.uid !== undefined) chmodSync(directory, 0o777);
        try {
            const source = readFileSync(join(shimsDir, name), "utf-8");
            expect(source).toContain("/run/ccc/clipboard.port");
            writeFileSync(shimFile, source.replaceAll("/run/ccc/clipboard.port", '"$CCC_TEST_PORT_FILE"'));
            chmodSync(shimFile, 0o644);
            if (state === "a directory") {
                mkdirSync(portFile);
            } else if (state !== "missing") {
                writeFileSync(portFile, "43123:mounted-file-token", { mode: 0o644 });
                chmodSync(portFile, state === "unreadable" ? 0o000 : 0o644);
            }

            // Observe actual outgoing curl arguments; no request reaches the network.
            writeFileSync(join(directory, "curl"), `#!/bin/sh
printf '%s\\n' "$@" > "$CCC_TEST_AUTH_CAPTURE"
printf 'fixture clipboard text'
`, { mode: 0o755 });
            // wl-copy currently only consumes stdin. Observe its inherited token
            // at that existing downstream command without adding a new copy API.
            writeFileSync(join(directory, "cat"), `#!/bin/sh
printf 'Authorization: Bearer %s\\n' "$CCC_CLIPBOARD_TOKEN" > "$CCC_TEST_AUTH_CAPTURE"
exec /bin/cat "$@"
`, { mode: 0o755 });
            chmodSync(join(directory, "curl"), 0o755);
            chmodSync(join(directory, "cat"), 0o755);

            const options = {
                cwd: directory,
                encoding: "utf-8" as const,
                env: {
                    ...process.env,
                    PATH: `${directory}:/usr/bin:/bin`,
                    ENV: "",
                    BASH_ENV: "",
                    CCC_CLIPBOARD_URL: "http://clipboard.invalid:43123",
                    CCC_CLIPBOARD_TOKEN: "current-session-token",
                    CCC_TEST_PORT_FILE: portFile,
                    CCC_TEST_AUTH_CAPTURE: captureFile,
                },
                timeout: 1000,
                ...identity,
            };
            if (state === "unreadable") {
                expect(existsSync(portFile)).toBe(true);
                const unreadable = spawnSync("/bin/sh", ["-c", '[ ! -r "$CCC_TEST_PORT_FILE" ]'], options);
                expect(unreadable.error).toBeUndefined();
                expect(unreadable.status).toBe(0);
            }

            const result = spawnSync("/bin/sh", [shimFile, ...args], {
                ...options,
                ...(name === "wl-copy" ? { input: "copy fixture input" } : {}),
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stderr).toBe("");
            const token = state === "readable" ? "mounted-file-token" : "current-session-token";
            expect(readFileSync(captureFile, "utf-8").split("\n")).toContain(`Authorization: Bearer ${token}`);
            expect(result.stdout).toBe(name === "wl-copy" ? "" : "fixture clipboard text");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
