/**
 * Windows host proof for an already running, disposable owner VM with an open editable GUI.
 *
 * node --import tsx scripts/real-tests/hyper-v-console-host.ts path/to/fixture.json
 * Fixture: {"vmId":"...","expectedName":"...","expectedNotes":"...","x":320,"y":240}
 * The point must be inside a visible text editor. The caller owns fixture creation and cleanup.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import {
    createHyperVWindowsClient,
    createHyperVWindowsPowerShellExecutor,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    hyperVWindowsPowerShellMemoryInput,
    type HyperVWindowsExecutionContext,
    type HyperVWindowsPowerShellFileRequest,
} from "../../src/hyper-v-windows/low-level/index.js";

type Fixture = { vmId: string; expectedName: string; expectedNotes: string; x: number; y: number };

function fixture(path: string): Fixture {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("console-fixture-invalid");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("console-fixture-invalid");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join("|") !== "expectedName|expectedNotes|vmId|x|y"
        || typeof item.vmId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.vmId)
        || typeof item.expectedName !== "string" || !item.expectedName.startsWith("ccc-")
        || typeof item.expectedNotes !== "string" || !item.expectedNotes
        || !Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)
        || (item.x as number) < 0 || (item.x as number) >= 640 || (item.y as number) < 0 || (item.y as number) >= 480) {
        throw new Error("console-fixture-invalid");
    }
    return item as Fixture;
}

function runPowerShell(request: HyperVWindowsPowerShellFileRequest, context: HyperVWindowsExecutionContext) {
    const executed = spawnSync(request.executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    ], {
        input: hyperVWindowsPowerShellMemoryInput(request), encoding: "utf8", windowsHide: true,
        timeout: context.timeoutMilliseconds, maxBuffer: context.maximumOutputBytes,
    });
    const processError = executed.error as NodeJS.ErrnoException | undefined;
    return {
        status: executed.status,
        stdout: executed.stdout || "",
        stderr: executed.stderr || "",
        ...(processError?.code === "ETIMEDOUT" ? { timedOut: true } : {}),
        ...(processError?.code === "ENOBUFS" ? { outputLimitExceeded: true } : {}),
        ...(processError ? { error: processError.code || "spawn-failed" } : {}),
    };
}

export function unfilteredHyperVConsolePixels(png: Buffer): Buffer {
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("console-png-invalid");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const bitDepth = png[24];
    const colorType = png[25];
    if (width !== 640 || height !== 480 || bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType ?? -1)) {
        throw new Error("console-png-format-unsupported");
    }
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType!]!;
    const rowBytes = width * channels;
    const blocks: Buffer[] = [];
    let offset = 8;
    while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString("ascii", offset + 4, offset + 8);
        if (length > 4 * 1024 * 1024 || offset + 12 + length > png.length) throw new Error("console-png-invalid");
        if (type === "IDAT") blocks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
        if (type === "IEND") break;
    }
    if (!blocks.length) throw new Error("console-png-invalid");
    const raw = inflateSync(Buffer.concat(blocks), { maxOutputLength: height * (rowBytes + 1) });
    if (raw.length !== height * (rowBytes + 1)) throw new Error("console-png-invalid");
    const pixels = Buffer.alloc(height * rowBytes);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (rowBytes + 1)];
        for (let x = 0; x < rowBytes; x++) {
            const left = x >= channels ? pixels[y * rowBytes + x - channels] : 0;
            const above = y > 0 ? pixels[(y - 1) * rowBytes + x] : 0;
            const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * rowBytes + x - channels] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) {
                const p = left + above - upperLeft;
                const a = Math.abs(p - left); const b = Math.abs(p - above); const c = Math.abs(p - upperLeft);
                predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
            } else if (filter !== 0) throw new Error("console-png-filter-unsupported");
            pixels[y * rowBytes + x] = (raw[y * (rowBytes + 1) + 1 + x] + predictor) & 255;
        }
    }
    return pixels;
}

async function main() {
    if (process.platform !== "win32") throw new Error("console-proof-windows-host-required");
    if (process.argv.length !== 3) throw new Error("usage: node --import tsx scripts/real-tests/hyper-v-console-host.ts fixture.json");
    const input = fixture(resolve(process.argv[2]!));
    const identity = {
        selector: { kind: "id" as const, id: input.vmId },
        expectedName: input.expectedName, expectedNotes: input.expectedNotes,
    };
    const client = createHyperVWindowsClient(createHyperVWindowsPowerShellExecutor({
        executable: "powershell.exe", run: runPowerShell,
    }));
    const first = await client.captureVMConsole(identity);
    const nonce = `CCC GUI ${randomBytes(5).toString("hex")}`;
    const pointer = {
        ...identity, x: input.x, y: input.y, width: first.width, height: first.height,
        nativeWidth: first.nativeWidth, nativeHeight: first.nativeHeight,
    };
    await client.sendVMConsoleInput({ ...pointer, action: "cursor" });
    await client.sendVMConsoleInput({ ...pointer, action: "click", button: "left" });
    await client.sendVMConsoleInput({ ...identity, action: "type", text: nonce });
    await client.sendVMConsoleInput({ ...identity, action: "key", keys: ["ENTER"] });
    await new Promise((done) => setTimeout(done, 300));
    const second = await client.captureVMConsole(identity);
    if (first.nativeWidth !== second.nativeWidth || first.nativeHeight !== second.nativeHeight) {
        throw new Error("console-proof-geometry-changed");
    }
    const before = Buffer.from(first.pngBase64, "base64");
    const after = Buffer.from(second.pngBase64, "base64");
    const a = unfilteredHyperVConsolePixels(before);
    const b = unfilteredHyperVConsolePixels(after);
    if (a.length !== b.length) throw new Error("console-proof-pixel-format-changed");
    const channels = a.length / (640 * 480);
    let changedBytes = 0;
    for (let y = Math.max(0, input.y - 80); y < Math.min(480, input.y + 80); y++) {
        for (let x = Math.max(0, input.x - 200); x < Math.min(640, input.x + 200); x++) {
            for (let channel = 0; channel < channels; channel++) {
                const index = (y * 640 + x) * channels + channel;
                if (a[index] !== b[index]) changedBytes++;
            }
        }
    }
    const output = join(process.cwd(), "results", "device-lab-real");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "hyper-v-console-proof-before.png"), before, { mode: 0o600 });
    writeFileSync(join(output, "hyper-v-console-proof-after.png"), after, { mode: 0o600 });
    if (changedBytes < 300) throw new Error(`console-proof-visible-change-missing changedBytes=${changedBytes}`);
    console.log(`PASS Hyper-V console screenshot -> cursor -> click -> type -> Enter -> screenshot changedBytes=${changedBytes}`);
    console.log(`HASH before=${createHash("sha256").update(before).digest("hex")} after=${createHash("sha256").update(after).digest("hex")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((cause) => {
        const code = cause instanceof Error ? cause.message : "console-proof-failed";
        console.error(`FAIL Hyper-V console proof: ${code}`);
        process.exitCode = 1;
    });
}
