import { createHash } from "crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { promises as fsPromises } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    assertHyperVDiskCapacity,
    assertHyperVHostCapacity,
    assertClonedDiskMatches,
    cloneHyperVBaseImage,
    hyperVHostCapacityRefusal,
    hyperVSourceIdentityRefusal,
} from "../device-lab/broker/hyper-v/vm-create-preflight.js";

// The clone and its rollback have only ever been provable on Windows: the one test that
// executes them is skipIf(platform !== "win32") and has never run in this repo's CI or on a
// developer machine. Everything below runs here, on a real filesystem, which is the point of
// moving this work out of the generated PowerShell.

let root = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-hyperv-create-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function sha256Of(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function writeBaseImage(bytes: Buffer): { imageRoot: string; imagePath: string; sha256: string } {
    const imageRoot = join(root, "images");
    mkdirSync(imageRoot, { recursive: true });
    const imagePath = join(imageRoot, "base.vhdx");
    writeFileSync(imagePath, bytes);
    return { imageRoot, imagePath, sha256: sha256Of(bytes) };
}

function devicePaths(): { deviceRoot: string; diskPath: string } {
    const deviceRoot = join(root, "devices", "device-1");
    const diskPath = join(deviceRoot, "disks", "root.vhdx");
    mkdirSync(join(deviceRoot, "disks"), { recursive: true });
    return { deviceRoot, diskPath };
}

describe("Hyper-V host capacity", () => {
    const host = { totalMemoryBytes: 64 * 1024 * 1024 * 1024, logicalProcessors: 8 };
    const totalMb = 64 * 1024;
    // max(2048, floor(65536 * 0.10)) = 6553
    const reserveMb = 6553;

    // Nothing pinned this arithmetic before. It was a string inside a generated script, so a
    // drift during the move would have been invisible in both languages.
    it.each([
        ["memory exactly at the reserve boundary", { memoryMb: totalMb - reserveMb, cpus: 1 }, null],
        ["one megabyte past it", { memoryMb: totalMb - reserveMb + 1, cpus: 1 }, "hyper-v-host-memory-capacity-exceeded"],
        ["cpus at twice the logical count", { memoryMb: 1024, cpus: 16 }, null],
        ["one cpu past twice the logical count", { memoryMb: 1024, cpus: 17 }, "hyper-v-host-cpu-capacity-exceeded"],
    ] as const)("refuses %s", (_label, request, expected) => {
        expect(hyperVHostCapacityRefusal(request, host)).toBe(expected);
    });

    // The floor matters on a small host: a tenth of 8 GB is 819 MB, well under the 2 GB the
    // host needs to stay usable while a guest runs.
    it("keeps a 2 GB floor under the ten percent reserve", () => {
        const small = { totalMemoryBytes: 8 * 1024 * 1024 * 1024, logicalProcessors: 4 };
        expect(hyperVHostCapacityRefusal({ memoryMb: 8192 - 2048, cpus: 1 }, small)).toBe(null);
        expect(hyperVHostCapacityRefusal({ memoryMb: 8192 - 2048 + 1, cpus: 1 }, small))
            .toBe("hyper-v-host-memory-capacity-exceeded");
    });

    it("reads the real host without throwing for a modest request", () => {
        expect(() => assertHyperVHostCapacity({ memoryMb: 1, cpus: 1 })).not.toThrow();
    });
});

describe("Hyper-V disk capacity", () => {
    it("refuses a disk the volume cannot hold with 10 GB to spare", async () => {
        const { diskPath } = devicePaths();
        await expect(assertHyperVDiskCapacity(diskPath, 1)).resolves.toBeUndefined();
        await expect(assertHyperVDiskCapacity(diskPath, Number.MAX_SAFE_INTEGER))
            .rejects.toThrow(/hyper-v-host-disk-capacity-exceeded/);
    });

    // It has to answer before the directories exist, because its answer decides whether to
    // make them. The nearest existing ancestor is on the same volume, which is the only thing
    // the answer depends on.
    it("answers for a path whose directories are not there yet", async () => {
        const unborn = join(root, "not", "yet", "made", "root.vhdx");
        await expect(assertHyperVDiskCapacity(unborn, 1)).resolves.toBeUndefined();
        await expect(assertHyperVDiskCapacity(unborn, Number.MAX_SAFE_INTEGER))
            .rejects.toThrow(/hyper-v-host-disk-capacity-exceeded/);
    });
});

describe("cloning the base image", () => {
    it("copies the image and proves what landed on disk", async () => {
        const bytes = Buffer.alloc(3 * 1024 * 1024 + 517, 7);
        bytes.write("vhdxfile", 0);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
        })).resolves.toEqual({ bytes: bytes.length });

        expect(readFileSync(diskPath).equals(bytes)).toBe(true);
    });

    it("refuses a base image whose bytes do not match the manifest", async () => {
        const { imageRoot, imagePath } = writeBaseImage(Buffer.alloc(4096, 1));
        const { deviceRoot, diskPath } = devicePaths();
        const created: string[] = [];

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: "b".repeat(64),
            deviceRoot,
            diskPath,
            onDestinationCreated: (path) => { created.push(path); },
        })).rejects.toThrow(/hyper-v-base-image-hash-mismatch/);
        expect(created).toEqual([diskPath]);
    });

    it("refuses a missing base image before creating anything", async () => {
        const imageRoot = join(root, "images");
        mkdirSync(imageRoot, { recursive: true });
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: join(imageRoot, "absent.vhdx"),
            expectedSha256: "a".repeat(64),
            deviceRoot,
            diskPath,
        })).rejects.toThrow(/hyper-v-base-image-not-found/);
        expect(() => statSync(diskPath)).toThrow();
    });

    // The destination is opened O_EXCL, matching the legacy FileMode::CreateNew. An existing
    // disk is a refusal, never an overwrite -- a device's disk is not something creation may
    // silently replace.
    it("refuses to overwrite a disk that is already there", async () => {
        const bytes = Buffer.alloc(4096, 3);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        writeFileSync(diskPath, "occupied");
        const created: string[] = [];

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
            onDestinationCreated: (path) => { created.push(path); },
        })).rejects.toThrow(/EEXIST/);
        expect(created).toEqual([]);
        expect(readFileSync(diskPath, "utf8")).toBe("occupied");
    });

    it("refuses a symlinked base image", async () => {
        const bytes = Buffer.alloc(4096, 5);
        const { imageRoot, sha256 } = writeBaseImage(bytes);
        const realPath = join(root, "outside.vhdx");
        writeFileSync(realPath, bytes);
        const linkPath = join(imageRoot, "link.vhdx");
        symlinkSync(realPath, linkPath);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: linkPath, expectedSha256: sha256, deviceRoot, diskPath,
        })).rejects.toThrow();
        expect(() => statSync(diskPath)).toThrow();
    });

    // The legacy needed a whole extra read of the base image to catch this. Hashing the bytes
    // as they are copied catches it for free, because the hash and the copy see the same
    // bytes through the same handle.
    it("detects a base image mutated in place while it is being copied", async () => {
        const bytes = Buffer.alloc(8 * 1024 * 1024, 9);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        const clone = cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
        });
        // Same inode, same length, different content -- invisible to every dev/ino/size check.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const descriptor = openSync(imagePath, "r+");
        try { writeSync(descriptor, Buffer.alloc(1024, 42), 0, 1024, bytes.length - 1024); } finally { closeSync(descriptor); }

        await expect(clone).rejects.toThrow(/hyper-v-base-image-hash-mismatch/);
    });

    it("stops before the first chunk when the deadline has already passed", async () => {
        const bytes = Buffer.alloc(4096, 2);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
            deadlineAt: Date.now() - 1,
        })).rejects.toThrow(/hyper-v-operation-deadline-exceeded/);
    });

    // The copy left the 120 s per-command clamp when it left PowerShell, so without a check
    // inside its own loop it would be bounded by nothing -- a hang rather than an error.
    //
    // Asserting that it throws is not enough: the read-back loop checks the deadline too, so
    // a copy that ignored the deadline entirely would still fail, just after writing every
    // byte. The partial destination is what proves the copy itself stopped.
    it("stops the copy itself when the deadline expires part way through", async () => {
        const bytes = Buffer.alloc(24 * 1024 * 1024, 4);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();

        await expect(cloneHyperVBaseImage({
            baseImageRoot: imageRoot,
            baseImagePath: imagePath,
            expectedSha256: sha256,
            deviceRoot,
            diskPath,
            deadlineAt: Date.now() + 2,
        })).rejects.toThrow(/hyper-v-operation-deadline-exceeded/);

        expect(statSync(diskPath).size).toBeLessThan(bytes.length);
    });

    // A swap the hash cannot see: same bytes, different file. Only the handle identity check
    // catches it, and it is the case the check exists for -- the bytes that were read came
    // from a file nobody verified.
    it("detects the base image being replaced by an identical-looking file mid-copy", async () => {
        const bytes = Buffer.alloc(16 * 1024 * 1024, 8);
        const { imageRoot, imagePath, sha256 } = writeBaseImage(bytes);
        const { deviceRoot, diskPath } = devicePaths();
        const impostor = join(imageRoot, "impostor.vhdx");
        writeFileSync(impostor, bytes);

        const clone = cloneHyperVBaseImage({
            baseImageRoot: imageRoot, baseImagePath: imagePath, expectedSha256: sha256, deviceRoot, diskPath,
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
        renameSync(impostor, imagePath);

        await expect(clone).rejects.toThrow(/hyper-v-base-image-identity-changed/);
    });
});

// The copy writes what it read, so these three failures cannot be provoked through the copy:
// the bytes would have to be corrupted underneath it. Driven directly instead, which is the
// reason the verification is its own function.
describe("proving what landed on disk", () => {
    async function withOpenFile<T>(bytes: Buffer, body: (handle: Awaited<ReturnType<typeof fsPromises.open>>) => Promise<T>): Promise<T> {
        const path = join(root, "landed.vhdx");
        writeFileSync(path, bytes);
        const handle = await fsPromises.open(path, "r+");
        try { return await body(handle); } finally { await handle.close(); }
    }

    it("accepts a disk whose bytes are the image", async () => {
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 11, 6);
        await withOpenFile(bytes, async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes))).resolves.toBeUndefined();
        });
    });

    it("refuses a disk whose content differs from the image", async () => {
        const bytes = Buffer.alloc(4096, 6);
        const corrupted = Buffer.from(bytes);
        corrupted[2048] = 200;
        await withOpenFile(corrupted, async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-hash-mismatch/);
        });
    });

    it("refuses a disk longer than the image even when the prefix matches", async () => {
        const bytes = Buffer.alloc(4096, 6);
        await withOpenFile(Buffer.concat([bytes, Buffer.alloc(16, 0)]), async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-length-mismatch/);
        });
    });

    it("refuses a disk shorter than the image rather than hashing past its end", async () => {
        const bytes = Buffer.alloc(4096, 6);
        await withOpenFile(bytes.subarray(0, 2048), async (handle) => {
            await expect(assertClonedDiskMatches(handle, bytes.length, sha256Of(bytes)))
                .rejects.toThrow(/hyper-v-created-disk-short-read/);
        });
    });
});

// The swap window cannot be hit deterministically through the copy: any file small enough for
// a fast test is copied before a swap can land, so a test driving this through cloneHyperVBaseImage
// proves only that some earlier check fired. Driven directly.
describe("proving which file the bytes came from", () => {
    const opened = { dev: 10, ino: 20, size: 4096, nlink: 1 };
    const path = (over: Partial<typeof opened> & { link?: boolean } = {}) => ({
        ...opened, ...over, isSymbolicLink: () => over.link === true,
    });

    it("accepts a handle and a path that still name the same file", () => {
        expect(hyperVSourceIdentityRefusal(opened, { ...opened }, path())).toBe(null);
    });

    it.each([
        ["the file was replaced under the handle", { ...opened }, path({ ino: 21 })],
        ["the path moved to another device", { ...opened }, path({ dev: 11 })],
        ["the path became a symlink", { ...opened }, path({ link: true })],
        ["the open file grew", { ...opened, size: 8192 }, path()],
        ["the open file gained a hard link", { ...opened, nlink: 2 }, path()],
        ["the open file changed inode", { ...opened, ino: 99 }, path()],
    ] as const)("refuses when %s", (_label, final, finalPath) => {
        expect(hyperVSourceIdentityRefusal(opened, final, finalPath))
            .toBe("hyper-v-base-image-identity-changed");
    });

    // The case the hash cannot see: same size, same content, different file.
    it("refuses an identical-looking file at a different inode", () => {
        expect(hyperVSourceIdentityRefusal(opened, { ...opened }, path({ ino: 777 })))
            .toBe("hyper-v-base-image-identity-changed");
    });
});
