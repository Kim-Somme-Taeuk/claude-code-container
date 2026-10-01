import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import {
    createHyperVWindowsClient,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionContext,
} from "@ccc/hyper-v/low-level/index.js";

const identity = {
    selector: { kind: "id" as const, id: "12345678-1234-1234-1234-123456789ABC" },
    expectedName: "ccc-owned-vm",
    expectedNotes: "owner-record",
};

const capture = {
    width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960,
    pngBase64: (() => {
        const chunk = (type: string, body: Buffer) => {
            const bytes = Buffer.alloc(12 + body.length);
            bytes.writeUInt32BE(body.length, 0);
            bytes.write(type, 4, "ascii");
            body.copy(bytes, 8);
            return bytes;
        };
        const header = Buffer.alloc(13);
        header.writeUInt32BE(640, 0);
        header.writeUInt32BE(480, 4);
        header[8] = 8;
        header[9] = 0;
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(480 * 641))),
            chunk("IEND", Buffer.alloc(0))]).toString("base64");
    })(),
};

function result(operation: string, items: unknown[]) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }) };
}

describe("Hyper-V typed console client", () => {
    it("uses an exact VM identity and a capture-only response budget", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest, _context: HyperVWindowsExecutionContext) =>
            result(request.operation, [capture]));
        const client = createHyperVWindowsClient({ execute });
        await expect(client.captureVMConsole(identity)).resolves.toEqual(capture);
        expect(execute).toHaveBeenCalledWith({
            schemaVersion: 1, operation: "Capture-VMConsole",
            selector: { kind: "id", id: identity.selector.id.toLowerCase() },
            expectedName: identity.expectedName, expectedNotes: identity.expectedNotes,
        }, expect.objectContaining({ maximumOutputBytes: 6 * 1024 * 1024, timeoutMilliseconds: 30000 }));
        await expect(client.captureVMConsole({ ...identity, selector: { kind: "id", id: "bad" } })).rejects.toMatchObject({ category: "validation" });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed image bytes and mismatched image dimensions", async () => {
        for (const item of [
            { ...capture, width: 641 },
            { ...capture, nativeHeight: 0 },
            { ...capture, pngBase64: "AAAA" },
            { ...capture, pngBase64: `${capture.pngBase64}extra` },
        ]) {
            const client = createHyperVWindowsClient({ execute: (request) => result(request.operation, [item]) });
            await expect(client.captureVMConsole(identity)).rejects.toMatchObject({ category: "protocol", code: "result-shape-invalid" });
        }
    });

    it("validates image coordinates and native geometry before sending pointer input", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => result(request.operation, []));
        const client = createHyperVWindowsClient({ execute });
        const pointer = { ...identity, action: "click" as const, button: "left" as const,
            x: 639, y: 479, width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960 };
        await client.sendVMConsoleInput(pointer);
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({
            operation: "Send-VMConsoleInput", selector: { kind: "id", id: identity.selector.id.toLowerCase() }, x: 639, y: 479,
        }), expect.objectContaining({ maximumOutputBytes: 64 * 1024 }));
        for (const bad of [{ ...pointer, x: 640 }, { ...pointer, y: -1 }, { ...pointer, nativeWidth: 0 },
            { ...pointer, width: 800 }]) {
            await expect(client.sendVMConsoleInput(bad)).rejects.toMatchObject({ category: "validation" });
        }
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("accepts bounded key and Unicode typing and rejects unknown keys", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => result(request.operation, []));
        const client = createHyperVWindowsClient({ execute });
        await client.sendVMConsoleInput({ ...identity, action: "key", keys: ["Ctrl", "A"] });
        await client.sendVMConsoleInput({ ...identity, action: "type", text: "한글 🧪" });
        expect(execute.mock.calls[0][0]).toMatchObject({ action: "key", keys: ["CTRL", "A"] });
        await expect(client.sendVMConsoleInput({ ...identity, action: "key", keys: ["HYPER", "A"] }))
            .rejects.toMatchObject({ category: "validation", code: "console-keys-invalid" });
        await expect(client.sendVMConsoleInput({ ...identity, action: "type", text: "a".repeat(2049) }))
            .rejects.toMatchObject({ category: "validation", code: "console-text-invalid" });
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it("reads cursor in the capture coordinate space", async () => {
        const client = createHyperVWindowsClient({ execute: (request) => result(request.operation, [{
            x: 319, y: 239, width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960,
        }]) });
        await expect(client.getVMConsoleCursor(identity)).resolves.toMatchObject({ x: 319, y: 239 });
    });
});
