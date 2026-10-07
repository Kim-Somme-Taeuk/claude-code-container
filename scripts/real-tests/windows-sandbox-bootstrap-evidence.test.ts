import { afterEach, describe, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWindowsSandboxBootstrapEvidence } from "./windows-sandbox-bootstrap-evidence.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-bootstrap-evidence-")); roots.push(homeDir);
    const options = { homeDir, artifactRoot: homeDir, ownerId: "a".repeat(16), deviceId: "windows-real-sandbox-123" };
    const downloads = join(homeDir, ".ccc/devices/owners", options.ownerId, "windows", options.deviceId, "downloads");
    mkdirSync(downloads, { recursive: true });
    return { options, downloads };
}
function capture(options: ReturnType<typeof fixture>["options"]) {
    const result = captureWindowsSandboxBootstrapEvidence(options);
    if (!("artifact" in result)) throw new Error("capture failed");
    const path = join(options.artifactRoot, result.artifact);
    return { result, path, bundle: JSON.parse(readFileSync(path, "utf8")) };
}
describe("local Sandbox bootstrap log preservation", () => {
    it("captures only fixed bounded logs in a separate private artifact", () => {
        const { options, downloads } = fixture();
        writeFileSync(join(downloads, "ccc-guest-helper.stderr.txt"), "PRIVATE raw diagnostic");
        const phase = JSON.stringify({ schemaVersion: 1, stage: "inspect-helper" });
        writeFileSync(join(downloads, "ccc-guest-helper-bootstrap-phase.json"), phase);
        writeFileSync(join(downloads, "other-secret.txt"), "DO NOT COPY");
        const { result, path, bundle } = capture(options);
        expect(bundle.files["ccc-guest-helper.stderr.txt"]).toEqual({ status: "captured", text: "PRIVATE raw diagnostic" });
        expect(bundle.files["ccc-guest-helper.stdout.txt"]).toEqual({ status: "absent" });
        expect(Object.keys(bundle.files)).toHaveLength(8);
        expect(bundle.files["ccc-guest-helper-bootstrap-phase.json"]).toEqual({ status: "captured", text: phase });
        expect(JSON.stringify(bundle)).not.toContain("DO NOT COPY");
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    });
    it("rejects oversized, linked and unreadable files without losing other logs", () => {
        const { options, downloads } = fixture();
        const secret = join(options.homeDir, "private.txt"); writeFileSync(secret, "OUTSIDE SECRET");
        linkSync(secret, join(downloads, "ccc-guest-helper.stderr.txt"));
        // File symlinks need privileges on Windows; hardlinks and directory
        // junctions below exercise its supported link boundaries without them.
        if (process.platform === "win32") linkSync(secret, join(downloads, "ccc-guest-helper.stdout.txt"));
        else symlinkSync(secret, join(downloads, "ccc-guest-helper.stdout.txt"));
        writeFileSync(join(downloads, "ccc-guest-helper-bootstrap.stdout.txt"), "x".repeat(8193));
        mkdirSync(join(downloads, "ccc-guest-helper-bootstrap.stderr.txt"));
        writeFileSync(join(downloads, "ccc-guest-helper.ready.txt"), "ready");
        const { bundle } = capture(options);
        expect(bundle.files["ccc-guest-helper-bootstrap.stdout.txt"].status).toBe("too-large");
        for (const name of ["ccc-guest-helper.stderr.txt", "ccc-guest-helper.stdout.txt", "ccc-guest-helper-bootstrap.stderr.txt"]) expect(bundle.files[name].status).toBe("unreadable");
        expect(bundle.files["ccc-guest-helper.ready.txt"].text).toBe("ready");
        expect(JSON.stringify(bundle)).not.toContain("OUTSIDE SECRET");
    });
    it("rejects linked source ancestors and output directories", () => {
        const { options, downloads } = fixture();
        const outside = join(options.homeDir, "outside"); mkdirSync(outside);
        writeFileSync(join(outside, "ccc-guest-helper.stderr.txt"), "OUTSIDE SECRET");
        rmSync(downloads, { recursive: true }); symlinkSync(outside, downloads, "junction");
        expect(JSON.stringify(capture(options).bundle)).not.toContain("OUTSIDE SECRET");
        rmSync(join(options.homeDir, "results"), { recursive: true });
        symlinkSync(outside, join(options.homeDir, "results"), "junction");
        expect(captureWindowsSandboxBootstrapEvidence(options)).toEqual({ error: "bootstrap-evidence-capture-failed" });
        expect(existsSync(join(outside, "device-lab-real"))).toBe(false);
    });
    it("bounds invalid identities and publication failure to one safe code", () => {
        const { options } = fixture();
        expect(captureWindowsSandboxBootstrapEvidence({ ...options, ownerId: "../private" })).toEqual({ error: "bootstrap-evidence-capture-failed" });
        expect(captureWindowsSandboxBootstrapEvidence({ ...options, deviceId: "../private" })).toEqual({ error: "bootstrap-evidence-capture-failed" });
        writeFileSync(join(options.homeDir, "results"), "blocked");
        expect(captureWindowsSandboxBootstrapEvidence(options)).toEqual({ error: "bootstrap-evidence-capture-failed" });
    });
});
