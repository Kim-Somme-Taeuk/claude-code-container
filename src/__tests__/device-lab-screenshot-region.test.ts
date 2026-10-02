import { describe, expect, it } from "vitest";
// @ts-ignore pure-JS decoder is owned by the MCP adapter
import { PNG } from "pngjs";
import { cropScreenshotResult, regionInputError } from "../../device-lab-mcp/src/screenshot-region.mjs";
const region = { x: 1, y: 1, width: 2, height: 1 };
function fixture() {
    const data = Buffer.from(Array.from({ length: 4 * 3 * 4 }, (_, index) => index));
    const png = PNG.sync.write({ width: 4, height: 3, data });
    return { data, result: { content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }, { type: "text", text: JSON.stringify({ incarnationId: "a".repeat(32), width: 4, height: 3 }) }] } };
}
describe("screenshot region", () => {
    it("crops exact pixels, retains identity, and states full-screen coordinate origin", () => {
        const { data, result } = fixture();
        const cropped = cropScreenshotResult(result, region);
        expect(cropped.isError).not.toBe(true);
        const decoded = PNG.sync.read(Buffer.from(cropped.content[0].data, "base64"));
        expect(decoded.width).toBe(2); expect(decoded.height).toBe(1);
        expect(decoded.data).toEqual(data.subarray(20, 28));
        expect(cropped.content[1]).toEqual(result.content[1]);
        expect(JSON.parse(cropped.content[2].text)).toEqual({ region, fullWidth: 4, fullHeight: 3, coordinateSpace: "full-screenshot" });
    });
    it.each([null, {}, { ...region, x: -1 }, { ...region, height: 0 }, { ...region, width: 1.5 }, { ...region, scale: 2 }, { ...region, x: Number.MAX_SAFE_INTEGER + 1 }])("rejects invalid region %j", value => expect(regionInputError(value)).toBeTruthy());
    it("rejects out-of-bounds without clipping or returning full pixels", () => {
        const output = cropScreenshotResult(fixture().result, { ...region, x: 3 });
        expect(output.isError).toBe(true);
        expect(output.content).toHaveLength(1);
        expect(output.content[0].text).toContain("out-of-bounds");
    });
    it("preserves provider errors", () => {
        const failure = { isError: true, content: [{ type: "text", text: "display-unavailable" }] };
        expect(cropScreenshotResult(failure, region)).toBe(failure);
    });
    it.each(["bad", "huge", "interlaced", "jpeg"])("rejects unsafe or unsupported image %s", kind => {
        const { result } = fixture();
        const image = result.content[0];
        if (kind === "jpeg") image.mimeType = "image/jpeg";
        else if (kind === "bad") image.data = "not a png";
        else {
            const bytes = Buffer.from(image.data!, "base64");
            if (kind === "huge") bytes.writeUInt32BE(100000, 16); else bytes[28] = 1;
            image.data = bytes.toString("base64");
        }
        expect(cropScreenshotResult(result, region).isError).toBe(true);
    });
});
