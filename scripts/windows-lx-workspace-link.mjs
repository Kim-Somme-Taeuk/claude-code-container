import { spawnSync } from "node:child_process";
import { rmdirSync } from "node:fs";
import { win32 } from "node:path";

function fsutil(action, path) {
    const command = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "fsutil.exe");
    return spawnSync(command, ["reparsepoint", action, path], {
        encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
        windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
}

export function isWindowsLxWorkspaceLink(path) {
    const result = fsutil("query", path);
    if (result.error || result.status !== 0) return false;
    // fsutil localizes the label, but the first line's hexadecimal tag is stable.
    const firstLine = String(result.stdout).split(/\r?\n/, 1)[0];
    return /:\s*0xa000001d\s*$/i.test(firstLine);
}

export function removeWindowsLxWorkspaceLink(path) {
    if (!isWindowsLxWorkspaceLink(path)) {
        throw new Error("workspace-linux-link-changed: refusing to remove an unverified workspace entry");
    }
    const result = fsutil("delete", path);
    if (result.error || result.status !== 0) {
        const cause = result.error?.code || `exit-${result.status}`;
        throw new Error(`workspace-linux-link-repair-failed: ${cause}; reparse metadata could not be removed`);
    }
    // fsutil removes only metadata, leaving a local directory. Never recurse:
    // a nonempty or concurrently replaced directory must survive this repair.
    rmdirSync(path);
}
