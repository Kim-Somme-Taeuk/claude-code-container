import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unfilteredHyperVConsolePixels } from "./hyper-v-console-host.js";
import { changedHyperVGuiViewportBytes } from "./hyper-v-gui-e2e.js";

function chunk(type: string, body: Buffer): Buffer {
    const result = Buffer.alloc(12 + body.length);
    result.writeUInt32BE(body.length, 0);
    result.write(type, 4, "ascii");
    body.copy(result, 8);
    return result;
}

function image(value: number): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(640, 0);
    header.writeUInt32BE(480, 4);
    header[8] = 8;
    header[9] = 0;
    const rows = Buffer.alloc(480 * 641);
    rows[1] = value;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
    ]);
}

describe("Hyper-V host console proof pixel comparison", () => {
    it("requires substantial decoded viewport change for the wheel proof", () => {
        const base = image(0);
        const caretOnly = image(255);
        expect(changedHyperVGuiViewportBytes(base, caretOnly)).toBe(0);
        const header = Buffer.alloc(13);
        header.writeUInt32BE(640, 0);
        header.writeUInt32BE(480, 4);
        header[8] = 8;
        const rows = Buffer.alloc(480 * 641);
        for (let y = 120; y < 380; y++) {
            for (let x = 100; x < 540; x++) rows[y * 641 + 1 + x] = (x + y) % 255;
        }
        const changed = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
        expect(changedHyperVGuiViewportBytes(base, changed)).toBeGreaterThan(3000);
    });
    it("compares decoded pixels instead of compressed PNG bytes", () => {
        const first = unfilteredHyperVConsolePixels(image(0));
        const second = unfilteredHyperVConsolePixels(image(255));
        expect(first.length).toBe(640 * 480);
        expect(first[0]).toBe(0);
        expect(second[0]).toBe(255);
        expect(second.subarray(1).equals(first.subarray(1))).toBe(true);
    });

    it("rejects malformed or unsupported input", () => {
        expect(() => unfilteredHyperVConsolePixels(Buffer.alloc(40))).toThrow("console-png-invalid");
        const unsupported = image(0);
        unsupported[24] = 16;
        expect(() => unfilteredHyperVConsolePixels(unsupported)).toThrow("console-png-format-unsupported");
    });
});
