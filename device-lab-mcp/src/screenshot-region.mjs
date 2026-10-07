import { PNG } from "pngjs";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function regionInputError(region) {
    if (!region || typeof region !== "object" || Array.isArray(region)
        || Object.keys(region).some(key => !["x", "y", "width", "height"].includes(key))
        || ["x", "y", "width", "height"].some(key => !Number.isSafeInteger(region[key]) || region[key] < (["x", "y"].includes(key) ? 0 : 1))) {
        return "screenshot region requires nonnegative integer x,y and positive integer width,height";
    }
    return null;
}
function failure(error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}
function dimensions(bytes) {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)
        || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("screenshot-region-invalid-png");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error("screenshot-region-image-too-large");
    // pngjs's interlaced sync decoder has no inflate bound. Desktop captures use
    // noninterlaced PNG; reject this encoding before passing untrusted bytes in.
    if (bytes[28] !== 0) throw new Error("screenshot-region-interlaced-png-unsupported");
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
        if (offset + size + 12 > bytes.length || (type === "IHDR" && offset !== 8)) throw new Error("screenshot-region-invalid-png");
        offset += size + 12;
        if (type === "IEND") { ended = size === 0; break; }
    }
    if (!ended || offset !== bytes.length) throw new Error("screenshot-region-invalid-png");
    return { width, height };
}
export function cropScreenshotResult(result, region) {
    if (result?.isError) return result;
    // Preserve structured provider errors without replacing them with a crop error.
    for (const item of result?.content || []) {
        if (item.type !== "text") continue;
        try { const value = JSON.parse(item.text); if (value?.ok === false || value?.error) return result; } catch { /* ordinary metadata */ }
    }
    const inputError = regionInputError(region);
    if (inputError) return failure(inputError);
    const images = result?.content?.filter(item => item.type === "image") || [];
    if (images.length !== 1 || images[0].mimeType !== "image/png") return failure("screenshot-region-requires-one-png-image");
    const image = images[0];
    try {
        if (typeof image.data !== "string" || image.data.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("screenshot-region-image-too-large");
        const bytes = Buffer.from(image.data, "base64");
        if (bytes.length > MAX_BYTES || bytes.toString("base64") !== image.data) throw new Error("screenshot-region-invalid-png");
        const full = dimensions(bytes);
        if (region.x > full.width - region.width || region.y > full.height - region.height) throw new Error("screenshot-region-out-of-bounds");
        const decoded = PNG.sync.read(bytes, { checkCRC: true });
        const data = Buffer.alloc(region.width * region.height * 4);
        for (let row = 0; row < region.height; row++) {
            const start = ((region.y + row) * full.width + region.x) * 4;
            decoded.data.copy(data, row * region.width * 4, start, start + region.width * 4);
        }
        const cropped = PNG.sync.write({ width: region.width, height: region.height, data });
        return { ...result, content: [
            ...result.content.map(item => item === image ? { ...item, data: cropped.toString("base64") } : item),
            { type: "text", text: JSON.stringify({ region, fullWidth: full.width, fullHeight: full.height, coordinateSpace: "full-screenshot" }) },
        ] };
    } catch (error) {
        return failure(error instanceof Error && error.message.startsWith("screenshot-region-") ? error.message : "screenshot-region-invalid-png");
    }
}
