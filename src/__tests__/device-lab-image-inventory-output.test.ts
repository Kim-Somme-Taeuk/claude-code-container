import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compactToolResult, compactToolValue } from "../../device-lab-mcp/src/public-output.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

const image = {
    id: "ubuntu-base", name: "Ubuntu base", ownerId: "private-owner", provider: "container-qemu",
    format: "qcow2", path: "/state/images/ubuntu-base/base.qcow2", sourcePath: "/state/incoming/base.qcow2",
    copied: true, sizeBytes: 4194304, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T01:00:00Z",
    custom: { ownerId: "opaque-user-value", createdAt: "user-date" },
};
const compactImage = {
    id: image.id, name: image.name, provider: image.provider, format: image.format,
    path: image.path, sourcePath: image.sourcePath, copied: image.copied, sizeBytes: image.sizeBytes, custom: image.custom,
};
const envelope = { ok: true, backend: "linux-vm", ownerId: "private-owner" };
const plan = {
    available: false, missing: ["provider permission"], deferred: ["start required"], warnings: ["host offline"],
    providerCommand: ["internal-provider", "create"], workspaceDir: "/internal/workspace",
    startCommand: ["internal-provider", "start"], stopCommand: ["internal-provider", "stop"],
    deleteCommand: ["internal-provider", "delete"], implemented: ["internal-v1"],
    image: "ubuntu", memoryMb: 4096, cpus: 2, providerInstance: "vm-instance",
};
const device = { id: "vm-1", backend: "linux-vm", status: "stopped", image: "ubuntu", memoryMb: 4096,
    cpus: 2, providerInstance: "vm-instance", providerPlan: plan };
const compactDevice = { ...device, providerPlan: {
    available: false, missing: ["provider permission"], deferred: ["start required"], warnings: ["host offline"],
} };

function payload(result: unknown): any {
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("producer-shaped image and inventory presentation", () => {
    it.each(["device_image_list", "device_image_import"])("compacts %s without dropping usable image fields", (name) => {
        const input = name === "device_image_list" ? { ...envelope, images: [image] } : { ...envelope, image };
        const expected = name === "device_image_list"
            ? { ok: true, backend: "linux-vm", images: [compactImage] }
            : { ok: true, backend: "linux-vm", image: compactImage };
        const before = JSON.stringify(input);
        expect(compactToolValue(name, input)).toEqual(expected);
        expect(JSON.stringify(input)).toBe(before);
    });

    it("compacts an empty image list without losing the empty result", () => {
        expect(compactToolValue("device_image_list", { ...envelope, images: [] }))
            .toEqual({ ok: true, backend: "linux-vm", images: [] });
    });

    it("preserves mixed unknown, malformed and failed image records", () => {
        const records = [null, "opaque", { ...image, provider: "other-provider" }, { ...image, id: 42 },
            { ...image, format: null }, { ...image, ok: false, error: "image-corrupt", recovery: { path: "/recover" } },
            { ...image, isError: true }, { ...image, error: "image-partial" }];
        expect(compactToolValue("device_image_list", { ...envelope, images: [image, ...records] }))
            .toEqual({ ok: true, backend: "linux-vm", images: [compactImage, ...records] });
    });

    it.each(["device_image_list", "device_image_import"])("preserves unknown or failed %s envelopes", (name) => {
        const data = name === "device_image_list" ? { images: [image] } : { image };
        for (const input of [
            { ownerId: "private-owner", ...data },
            { ...envelope, backend: "future-vm", ...data },
            { ...envelope, ok: false, error: "partial-image-failure", recovery: { ownerId: "keep" }, ...data },
        ]) expect(compactToolValue(name, input)).toEqual(input);
    });

    it("preserves MCP error flags and native content blocks", () => {
        const failure = { ...envelope, ok: false, error: "import-failed", image };
        const resource = { type: "resource_link", uri: "file:///image.qcow2", name: "image" };
        const reply = { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }, resource] };
        const result = compactToolResult("device_image_import", reply);
        expect(result.isError).toBe(true);
        expect(payload(result)).toEqual(failure);
        expect(result.content[1]).toEqual(resource);
    });

    it.each([false, true])("compacts inventory plans (nested=%s), retaining unavailable-state evidence", (nested) => {
        const devices = [device, { ...device, id: "failed-vm", providerPlan: { ...plan, ok: false, error: "plan-failed" } }, null];
        const expectedDevices = [compactDevice, devices[1], null];
        const input = nested ? { backends: [{ name: "linux-vm", available: false, missing: ["qemu"], devices }] } : { devices };
        const expected = nested ? { backends: [{ name: "linux-vm", available: false, missing: ["qemu"], devices: expectedDevices }] } : { devices: expectedDevices };
        const before = JSON.stringify(input);
        expect(compactToolValue("device_inventory", input)).toEqual(expected);
        expect(JSON.stringify(input)).toBe(before);
    });

    it("preserves creation and dry-run command plans", () => {
        for (const input of [{ ok: true, device }, { ok: true, dryRun: true, device }]) {
            expect(compactToolValue("device_create", input)).toEqual(input);
        }
    });

    it.each(["device_run_flow"])("projects nested known results in %s", (name) => {
        const input = { ok: true, results: [
            { index: 0, tool: "device_image_list", isError: false, content: [{ type: "json", value: { ...envelope, images: [image] } }] },
            { index: 1, tool: "device_inventory", isError: false, content: [{ type: "json", value: { devices: [device] } }] },
        ] };
        const before = JSON.stringify(input);
        expect(compactToolValue(name, input)).toEqual({ ok: true, results: [
            { index: 0, tool: "device_image_list", isError: false, content: [{ type: "json", value: { ok: true, backend: "linux-vm", images: [compactImage] } }] },
            { index: 1, tool: "device_inventory", isError: false, content: [{ type: "json", value: { devices: [compactDevice] } }] },
        ] });
        expect(JSON.stringify(input)).toBe(before);
    });

    it("imports and lists real isolated image metadata over MCP in compact and detailed modes", { timeout: TIMEOUT }, async () => {
        const env: Record<string, string> = {};
        const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
            const root = join(home, "labs");
            env.CCC_LAB_STATE_DIR = root;
            mkdirSync(join(root, "incoming"), { recursive: true });
            writeFileSync(join(root, "incoming", "base.qcow2"), "fixture-image-bytes");
        } });
        try {
            const call = async (name: string, args: Record<string, unknown>) => {
                const result = await context.client.callTool({ name, arguments: args });
                expect(result.isError).not.toBe(true);
                return payload(result);
            };
            expect(await call("list_images", { detail: false })).toEqual({ backend: "linux-vm", images: [] });
            const detailed = await call("import_image", { detail: true, name: "Base", sourcePath: "incoming/base.qcow2" });
            expect(detailed.ownerId).toEqual(expect.any(String));
            expect(detailed.image).toMatchObject({ id: "base", provider: "container-qemu", format: "qcow2", copied: true,
                ownerId: detailed.ownerId, createdAt: expect.any(String), updatedAt: expect.any(String), path: expect.any(String), sourcePath: expect.any(String) });
            const { ownerId: _owner, createdAt: _created, updatedAt: _updated, ...expectedImage } = detailed.image;
            expect(await call("list_images", { detail: false })).toEqual({ backend: "linux-vm", images: [expectedImage] });
            expect(await call("list_images", { detail: true })).toEqual({ ok: true, backend: "linux-vm", ownerId: detailed.ownerId, images: [detailed.image] });
            const compactImport = await call("import_image", { detail: false, name: "Base", sourcePath: "incoming/base.qcow2", force: true });
            expect(compactImport).toEqual({ backend: "linux-vm", image: expectedImage });
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });
});
