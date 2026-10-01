import { chmodSync, mkdirSync, mkdtempSync, existsSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runHyperVCreateCompensation } from "@ccc/device-lab/device-lab/broker/hyper-v/vm-create-compensation.js";
import type { HyperVCreateEffect } from "@ccc/hyper-v/lifecycle/index.js";

// Slice 3A wrote the compensation contract and shipped no executor, so none of this had ever
// run. The equivalent PowerShell assertions are skipIf(platform !== "win32") and have never
// run in this repo either. These execute against a real filesystem.

let root = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-hyperv-comp-"));
});

afterEach(() => {
    try { chmodSync(root, 0o700); } catch { /* the test may not have changed it */ }
    rmSync(root, { recursive: true, force: true });
});

function deviceTree(): { deviceRoot: string; diskDirectory: string; diskPath: string } {
    const deviceRoot = join(root, "device-1");
    const diskDirectory = join(deviceRoot, "disks");
    mkdirSync(diskDirectory, { recursive: true });
    const diskPath = join(diskDirectory, "root.vhdx");
    writeFileSync(diskPath, "disk");
    return { deviceRoot, diskDirectory, diskPath };
}

describe("compensating what creation actually did", () => {
    it("removes the disk and both directories it made, innermost first", async () => {
        const { deviceRoot, diskDirectory, diskPath } = deviceTree();
        const effects: HyperVCreateEffect[] = [
            { kind: "directory-created", path: deviceRoot },
            { kind: "directory-created", path: diskDirectory },
            { kind: "file-created", path: diskPath },
        ];

        const attempts = await runHyperVCreateCompensation(effects);

        expect(attempts.map((attempt) => [attempt.compensation.kind, attempt.ok])).toEqual([
            ["delete-file", true],
            ["delete-directory", true],
            ["delete-directory", true],
        ]);
        expect(existsSync(deviceRoot)).toBe(false);
    });

    // The single most important property here, and the reason compensation derives from
    // effects rather than from the request: a device root that was already on disk produces no
    // effect, so nothing can remove it.
    it("never removes a device root it did not create", async () => {
        const { deviceRoot, diskDirectory, diskPath } = deviceTree();
        const effects: HyperVCreateEffect[] = [
            { kind: "directory-created", path: diskDirectory },
            { kind: "file-created", path: diskPath },
        ];

        await runHyperVCreateCompensation(effects);

        expect(existsSync(deviceRoot)).toBe(true);
        expect(existsSync(diskDirectory)).toBe(false);
    });

    // Non-recursive is the decision slice 3A left open. A directory holding something creation
    // did not make stays, and that is the right answer rather than a cleanup failure.
    it("leaves a directory that holds something creation did not make", async () => {
        const { deviceRoot, diskDirectory, diskPath } = deviceTree();
        const stranger = join(diskDirectory, "not-ours.txt");
        writeFileSync(stranger, "someone else");
        const effects: HyperVCreateEffect[] = [
            { kind: "directory-created", path: deviceRoot },
            { kind: "directory-created", path: diskDirectory },
            { kind: "file-created", path: diskPath },
        ];

        const attempts = await runHyperVCreateCompensation(effects);

        expect(attempts[0]).toMatchObject({ ok: true });
        expect(attempts[1]).toMatchObject({ ok: false });
        expect(existsSync(stranger)).toBe(true);
        expect(existsSync(deviceRoot)).toBe(true);
    });

    // The legacy wrapped each rollback step in its own catch so a failure to remove the disk
    // still let it remove the device root. A caller that stops at the first error leaves the
    // residue the rest exists to clear.
    it("attempts every entry even when an earlier one fails", async () => {
        const { deviceRoot, diskDirectory } = deviceTree();
        const effects: HyperVCreateEffect[] = [
            { kind: "directory-created", path: deviceRoot },
            { kind: "directory-created", path: diskDirectory },
            // Never created, so its removal fails -- and must not stop the two that follow.
            { kind: "file-created", path: join(diskDirectory, "absent.vhdx") },
        ];
        rmSync(join(diskDirectory, "root.vhdx"));

        const attempts = await runHyperVCreateCompensation(effects);

        expect(attempts.map((attempt) => attempt.ok)).toEqual([false, true, true]);
        expect(existsSync(deviceRoot)).toBe(false);
    });

    it("refuses to delete through a symlinked path component", async () => {
        const realDirectory = join(root, "real");
        mkdirSync(realDirectory);
        const victim = join(realDirectory, "root.vhdx");
        writeFileSync(victim, "not creation's to delete");
        const link = join(root, "link");
        symlinkSync(realDirectory, link);

        const attempts = await runHyperVCreateCompensation([
            { kind: "file-created", path: join(link, "root.vhdx") },
        ]);

        expect(attempts[0]).toMatchObject({ ok: false });
        expect(existsSync(victim)).toBe(true);
    });

    it("refuses to remove a symlink standing where a created directory should be", async () => {
        const realDirectory = join(root, "real");
        mkdirSync(realDirectory);
        writeFileSync(join(realDirectory, "keep.txt"), "keep");
        const link = join(root, "device-1");
        symlinkSync(realDirectory, link);

        const attempts = await runHyperVCreateCompensation([
            { kind: "directory-created", path: link },
        ]);

        expect(attempts[0]).toMatchObject({ ok: false });
        expect(existsSync(join(realDirectory, "keep.txt"))).toBe(true);
    });

    // A vm-created effect cannot arise before a VM exists. Reaching here means something
    // recorded an effect it had no business recording, which is a bug to surface rather than
    // a host state to act on.
    it("refuses a vm removal, which cannot be reachable on this path", async () => {
        const attempts = await runHyperVCreateCompensation([
            { kind: "vm-created", vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        ]);

        expect(attempts).toEqual([{
            compensation: { kind: "remove-vm", vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
            ok: false,
            error: "hyper-v-create-compensation-unsupported",
        }]);
    });

    it("removes the VM by its recorded id before the disk and directories", async () => {
        const { deviceRoot, diskDirectory, diskPath } = deviceTree();
        const vmId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const calls: string[] = [];
        const attempts = await runHyperVCreateCompensation([
            { kind: "directory-created", path: deviceRoot },
            { kind: "directory-created", path: diskDirectory },
            { kind: "file-created", path: diskPath },
            { kind: "vm-created", vmId },
        ], { removeVM: async (id) => { calls.push(id); } });

        expect(calls).toEqual([vmId]);
        expect(attempts.map(({ compensation, ok }) => [compensation.kind, ok])).toEqual([
            ["remove-vm", true], ["delete-file", true],
            ["delete-directory", true], ["delete-directory", true],
        ]);
        expect(existsSync(deviceRoot)).toBe(false);
    });

    it("preserves the attached disk when VM removal fails", async () => {
        const { deviceRoot, diskDirectory, diskPath } = deviceTree();
        const attempts = await runHyperVCreateCompensation([
            { kind: "directory-created", path: deviceRoot },
            { kind: "directory-created", path: diskDirectory },
            { kind: "file-created", path: diskPath },
            { kind: "vm-created", vmId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        ], { removeVM: async () => { throw new Error("remove-failed"); } });

        expect(attempts.map(({ ok }) => ok)).toEqual([false]);
        expect(attempts[0]?.error).toBe("remove-failed");
        expect(existsSync(diskPath)).toBe(true);
        expect(existsSync(deviceRoot)).toBe(true);
    });

    // The report is read by a human deciding whether residue was left behind, so the
    // condition is named rather than carried as a raw errno.
    it.each([
        ["a file standing where a created directory should be", "directory-created" as const],
        ["a directory standing where a created file should be", "file-created" as const],
    ])("names the condition when %s", async (_label, kind) => {
        const path = join(root, "surprise");
        if (kind === "directory-created") writeFileSync(path, "a file"); else mkdirSync(path);

        const attempts = await runHyperVCreateCompensation([
            kind === "directory-created" ? { kind, path } : { kind, path },
        ]);

        expect(attempts[0]).toMatchObject({ ok: false, error: "hyper-v-create-compensation-path-invalid" });
        expect(existsSync(path)).toBe(true);
    });

    // Unlinking a symlink would only remove the link, so the target is safe either way. The
    // reason this is named separately is diagnostic: "something put a link where the disk
    // should be" is a different situation from "the disk is not a file", and an operator
    // reading the report should not have to guess which happened.
    it("names a symlink left where the created disk should be", async () => {
        const outside = join(root, "elsewhere.vhdx");
        writeFileSync(outside, "not creation's");
        const diskPath = join(root, "root.vhdx");
        symlinkSync(outside, diskPath);

        const attempts = await runHyperVCreateCompensation([{ kind: "file-created", path: diskPath }]);

        expect(attempts[0]).toMatchObject({ ok: false });
        expect(attempts[0]?.error).toMatch(/path-symlink-rejected/);
        expect(existsSync(outside)).toBe(true);
    });

    it("reports rather than throws when nothing can be removed", async () => {
        const attempts = await runHyperVCreateCompensation([
            { kind: "file-created", path: join(root, "absent", "root.vhdx") },
        ]);

        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.ok).toBe(false);
    });

    it("does nothing at all when creation recorded nothing", async () => {
        await expect(runHyperVCreateCompensation([])).resolves.toEqual([]);
    });
});
