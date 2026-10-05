import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWindowsSandboxExecEvidence, requireWindowsSandboxExecSuccess, requireWindowsSandboxFocusSuccess, WindowsSandboxExecFailure } from "./windows-sandbox-exec-evidence.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ccc-sandbox-exec-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it("accepts only explicit successful guest execution without writing evidence", () => {
    requireWindowsSandboxExecSuccess({ status: 0, stdout: "ok", stderr: "" }, root);
    expect(readdirSync(root)).toEqual([]);
});

it.each(["window-focus-denied", "private error C:\\secret", '{"error":"private"}'])("retains plain or structured focus failure evidence: %s", (raw) => {
    let failure: Error | undefined;
    try { requireWindowsSandboxFocusSuccess({ isError: true, content: [{ type: "text", text: raw }] }, root); }
    catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(WindowsSandboxExecFailure);
    expect(failure!.message).toContain(raw === "window-focus-denied" ? "window-focus-denied." : "sandbox-window-focus-failed.");
    expect(failure!.message).not.toContain("private");
    const path = failure!.message.split("Local raw exec evidence: ")[1];
    expect(JSON.parse(readFileSync(join(root, path), "utf8")).stderr.text).toBe(raw);
});

it("does not turn success into an error or expose error prefixes containing raw text", () => {
    requireWindowsSandboxFocusSuccess({ content: [{ type: "text", text: '{"ok":true}' }] }, root);
    expect(readdirSync(root)).toEqual([]);
    expect(() => requireWindowsSandboxFocusSuccess({ isError: true, content: [{ type: "text", text: "window-focus-denied private" }] }, root))
        .toThrow(/^sandbox-window-focus-failed\./);
});

it("captures a successful diagnostic probe without fabricating a failed exit code", () => {
    const reference = captureWindowsSandboxExecEvidence({ status: 0, stdout: '{"alive":false,"phase":"absent"}' }, root);
    const path = reference.split("Local raw exec evidence: ")[1];
    const value = JSON.parse(readFileSync(join(root, path), "utf8"));
    expect(value.status).toBe(0);
    expect(value.stdout.text).toBe('{"alive":false,"phase":"absent"}');
});

it.each([1, 124, undefined, "0", NaN])("keeps failure status %s and bounded raw output out of the public error", (status) => {
    let failure: unknown;
    try { requireWindowsSandboxExecSuccess({ status, stdout: "private-output", stderr: "private-error".repeat(1000) }, root); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(WindowsSandboxExecFailure);
    const message = (failure as Error).message;
    expect(message).toContain(`status=${Number.isSafeInteger(status) ? status : "missing-or-invalid"}`);
    expect(message).not.toContain("private-");
    const path = message.split("Local raw exec evidence: ")[1];
    const value = JSON.parse(readFileSync(join(root, path), "utf8"));
    expect(value.stdout).toEqual({ text: "private-output", truncated: false });
    expect(value.stderr.text).toHaveLength(8192);
    expect(value.stderr.truncated).toBe(true);
});

it.each([{ status: 0, ok: false }, { status: 0, error: "failed" }, null, { result: { status: 0 } }])("rejects failed or unexpected envelopes: %j", (payload) => {
    expect(() => requireWindowsSandboxExecSuccess(payload, root)).toThrow(WindowsSandboxExecFailure);
});

it("preserves guest failure when diagnostic storage is unavailable", () => {
    writeFileSync(join(root, "results"), "keep");
    expect(() => requireWindowsSandboxExecSuccess({ status: 124 }, root))
        .toThrow("guest-exec-failed: status=124. Local exec evidence could not be saved.");
    expect(readFileSync(join(root, "results"), "utf8")).toBe("keep");
});
