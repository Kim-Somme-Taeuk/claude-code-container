import { linkSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_SCREENSHOT_LIMIT_BYTES, screenshotFileResult } from "@ccc/device-lab/providers/screenshot-file.mjs";

describe("device-lab screenshot file boundaries", () => {
    let root: string | null = null;

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = null;
    });

    function tempRoot() {
        root = mkdtempSync(join(tmpdir(), "ccc-screenshot-file-"));
        return root;
    }

    it("returns a bounded regular screenshot as image content", () => {
        const file = join(tempRoot(), "screenshot.png");
        writeFileSync(file, "fakepng");

        expect(screenshotFileResult(file, "test-screenshot")).toEqual({
            content: [{ type: "image", data: Buffer.from("fakepng").toString("base64"), mimeType: "image/png" }],
        });
    });

    it("rejects a symbolic screenshot link when the host permits creating one", (context) => {
        const directory = tempRoot();
        const source = join(directory, "source.png");
        const symbolic = join(directory, "symbolic.png");
        writeFileSync(source, "fakepng");
        try { symlinkSync(source, symbolic); }
        catch (error) {
            if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
                context.skip(true, "Windows file symlinks require Developer Mode or privilege"); return;
            }
            throw error;
        }
        expect(screenshotFileResult(symbolic, "test-screenshot")).toEqual(expect.objectContaining({ isError: true }));
    });

    it("rejects missing, empty, linked, and oversized outputs", () => {
        const directory = tempRoot();
        const source = join(directory, "source.png");
        const empty = join(directory, "empty.png");
        const hard = join(directory, "hard.png");
        const oversized = join(directory, "oversized.png");
        writeFileSync(source, "fakepng");
        writeFileSync(empty, "");
        linkSync(source, hard);
        writeFileSync(oversized, "x");
        truncateSync(oversized, DEVICE_SCREENSHOT_LIMIT_BYTES + 1);

        expect(screenshotFileResult(join(directory, "missing.png"), "test-screenshot")).toEqual(expect.objectContaining({ isError: true }));
        expect(screenshotFileResult(empty, "test-screenshot")).toEqual(expect.objectContaining({ isError: true }));
        expect(screenshotFileResult(hard, "test-screenshot")).toEqual(expect.objectContaining({ isError: true }));
        expect(screenshotFileResult(oversized, "test-screenshot")).toEqual(expect.objectContaining({ isError: true }));
    });
});
