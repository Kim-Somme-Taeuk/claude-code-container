import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDeviceLabPathWithinRoot } from "#device-lab/providers/state/state-file.mjs";

export class WindowsSandboxExecFailure extends Error {}

export function requireWindowsSandboxFocusSuccess(result: any, artifactRoot: string): void {
    if (result?.isError !== true) return;
    // Preserve plain-text provider errors before the JSON-only parser loses
    // them. Only exact, known codes are safe to put in the public report.
    let raw = "";
    for (const item of Array.isArray(result.content) ? result.content : []) {
        if (item?.type === "text" && typeof item.text === "string") raw += item.text.slice(0, 8193 - raw.length);
        if (raw.length >= 8193) break;
    }
    const code = ["window-focus-denied", "window-not-found", "invalid-window-handle", "desktop-control-failed"].includes(raw)
        ? raw : "sandbox-window-focus-failed";
    throw new WindowsSandboxExecFailure(`${code}.${captureWindowsSandboxExecEvidence({ stderr: raw }, artifactRoot)}`);
}

// Exec can return an MCP success with a nonzero guest exit status. Preserve
// that distinction without printing guest output in the public test report.
export function requireWindowsSandboxExecSuccess(payload: any, artifactRoot: string): void {
    if (payload?.status === 0 && payload?.ok !== false && !payload?.error) return;
    const status = Number.isSafeInteger(payload?.status) ? payload.status : "missing-or-invalid";
    throw new WindowsSandboxExecFailure(`guest-exec-failed: status=${status}.${captureWindowsSandboxExecEvidence(payload, artifactRoot)}`);
}

export function captureWindowsSandboxExecEvidence(payload: any, artifactRoot: string): string {
    const status = Number.isSafeInteger(payload?.status) ? payload.status : "missing-or-invalid";
    let evidence = " Local exec evidence could not be saved.";
    try {
        const artifact = `results/device-lab-real/windows-sandbox-exec-${randomUUID()}.json`;
        for (const directory of [join(artifactRoot, "results"), join(artifactRoot, "results", "device-lab-real")]) {
            assertDeviceLabPathWithinRoot(artifactRoot, directory, "exec-evidence-output");
            if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
        }
        const destination = join(artifactRoot, artifact);
        assertDeviceLabPathWithinRoot(artifactRoot, destination, "exec-evidence-output");
        const output = (value: unknown) => typeof value === "string"
            ? { text: value.slice(0, 8192), truncated: value.length > 8192 }
            : { absent: true };
        writeFileSync(destination, JSON.stringify({ schemaVersion: 1, status,
            privacy: "Private local guest command output; may contain sensitive data. Do not publish automatically.",
            stdout: output(payload?.stdout), stderr: output(payload?.stderr),
        }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        evidence = ` Local raw exec evidence: ${artifact}`;
    } catch { /* A diagnostic write failure must not replace the guest failure. */ }
    return evidence;
}
