import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { snapshotNestedSource } from "../../scripts/real-tests/nested-hyper-v-source.ts";
import { saveNestedFailure } from "../../scripts/real-tests/nested-hyper-v.ts";

vi.mock("child_process", { spy: true });

const roots: string[] = [];
beforeEach(async () => {
    const actual = await vi.importActual<typeof childProcess>("child_process");
    vi.mocked(childProcess.spawnSync).mockReset().mockImplementation(actual.spawnSync);
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory() {
    const root = mkdtempSync(join(tmpdir(), "ccc-nested-source-diagnostic-"));
    roots.push(root);
    return root;
}

describe("nested source Git failure diagnostics", () => {
    it.each([
        { code: "ENOENT", detail: "git-executable-or-working-directory-missing" },
        { code: "ETIMEDOUT", detail: "git-list-timed-out" },
        { code: "ENOBUFS", detail: "git-list-output-too-large" },
        { code: "EACCES", detail: "git-list-command-failed" },
        { stderr: "fatal: not a git repository (or any of the parent directories): .git", detail: "git-not-a-repository" },
        { stderr: "fatal: detected dubious ownership in repository at 'C:/private/project'", detail: "git-dubious-ownership" },
        { stderr: "fatal: unknown failure", detail: "git-list-command-failed" },
    ])("classifies $detail without leaking process output", ({ code, stderr, detail }) => {
        const root = directory();
        const outputRoot = join(root, "results");
        const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
            pid: 0, output: [], status: code ? null : 128, signal: code === "ETIMEDOUT" ? "SIGTERM" : null,
            stdout: "PRIVATE_SOURCE_FILENAME", stderr: `${stderr ?? ""}\npassword=SECRET_TOKEN`,
            ...(code ? { error: Object.assign(new Error("SECRET_PROCESS_MESSAGE"), { code }) } : {}),
        });
        let failure: any;
        try { snapshotNestedSource(root, outputRoot); } catch (error) { failure = error; }
        expect(failure?.message).toBe("nested-source-git-list-failed");
        expect(failure.diagnosticPayload).toMatchObject({
            error: "nested-source-git-list-failed", detail, timedOut: code === "ETIMEDOUT",
            status: code ? null : 128, outputRedacted: true,
            ...(code ? { diagnosticCode: code } : {}),
        });
        if (code === "ETIMEDOUT") expect(failure.diagnosticPayload.signal).toBe("SIGTERM");
        expect(spawn).toHaveBeenCalledExactlyOnceWith("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000, windowsHide: true,
        });
        // Failure never creates a partial archive or falls back to copying the tree.
        expect(existsSync(outputRoot)).toBe(false);
        saveNestedFailure(failure, outputRoot, "snapshot-source", undefined, failure.diagnosticPayload);
        const saved = readFileSync(join(outputRoot, "failure.json"), "utf8");
        expect(JSON.parse(saved)).toMatchObject({
            stage: "snapshot-source", code: "nested-source-git-list-failed",
            diagnostics: [expect.objectContaining({ detail })],
        });
        for (const secret of ["SECRET_TOKEN", "SECRET_PROCESS_MESSAGE", "PRIVATE_SOURCE_FILENAME", "C:/private/project"]) {
            expect(saved).not.toContain(secret);
        }
    });

    it("does not serialize unrecognized process error codes", () => {
        vi.spyOn(childProcess, "spawnSync").mockReturnValue({
            pid: 0, output: [], status: null, signal: null, stdout: "", stderr: "",
            error: Object.assign(new Error("private"), { code: "PRIVATE_ERROR_VALUE" }),
        });
        expect(() => snapshotNestedSource(directory(), "unused-output")).toThrowError(expect.objectContaining({
            diagnosticPayload: expect.objectContaining({ diagnosticCode: "git-process-error" }),
        }));
    });

    it("reports a real nonrepository without changing Git trust configuration", () => {
        const root = directory();
        expect(() => snapshotNestedSource(root, join(root, "results"))).toThrowError(expect.objectContaining({
            diagnosticPayload: expect.objectContaining({ detail: "git-not-a-repository", status: 128 }),
        }));
    });
});
