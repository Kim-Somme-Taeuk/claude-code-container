import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";

// Exercise actual server normalization and dispatch, observing the provider boundary.
const fixture = vi.hoisted(() => ({ handlers: [] as any[], calls: [] as Array<{ provider: string; name: string; args: any }> }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
    setRequestHandler(_schema: unknown, handler: any) { fixture.handlers.push(handler); }
    async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../../device-lab-mcp/src/backends/linux-vm.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    handleLinuxVmManagementTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "linux-management", name, args });
        return name.startsWith("device_image_") ? { content: [{ type: "text", text: '{"ok":true,"images":[]}' }] } : undefined;
    },
    handleLinuxVmTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "linux", name, args });
        return args.backend === "linux-vm" ? { content: [{ type: "text", text: '{"ok":true}' }] } : undefined;
    },
}));
vi.mock("../../device-lab-mcp/src/backends/macos-vm.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    handleMacosTool: async (name: string, args: any) => {
        fixture.calls.push({ provider: "macos", name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
}));
vi.mock("../../device-lab-mcp/src/broker.mjs", async (original) => ({
    ...await original<Record<string, any>>(),
    brokerDeviceTool: async () => { throw new Error("single-backend action reached host broker"); },
}));
import { startServer } from "../../device-lab-mcp/src/server.mjs";
import { ALL_TOOLS, TOOLS, SINGLE_BACKEND_TOOL_DEFAULTS } from "../../device-lab-mcp/src/tools.mjs";
import { normalizeToolArgs, flowStepArguments } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { createLab, ownerId } from "../../device-lab-mcp/src/backends/linux-vm.mjs";

const defaults = {
    device_image_list: "linux-vm", device_image_import: "linux-vm", device_target_list: "linux-vm",
    device_readiness_probe: "linux-vm", device_session_open: "linux-vm", device_workspace_sync: "linux-vm",
    device_artifacts_export: "linux-vm", device_guest_agent_status: "linux-vm", device_guest_agent_provision: "linux-vm",
    device_base_image_create: "macos-vm", device_base_image_clone: "macos-vm",
};
const entries = Object.entries(defaults);
const ownedActions = ["device_readiness_probe", "device_session_open", "device_workspace_sync", "device_artifacts_export", "device_guest_agent_status", "device_guest_agent_provision"];
const parse = (result: any) => JSON.parse(result.content[0].text);
const call = (name: string, args: any) => fixture.handlers[1]({ params: { name, arguments: args } });

describe("bounded single-backend argument contract", () => {
    beforeAll(async () => { await startServer(); });
    beforeEach(() => { fixture.calls.length = 0; });
    it("uses exactly the eleven intentional defaults", () => { expect(SINGLE_BACKEND_TOOL_DEFAULTS).toEqual(defaults); });
    it.each(entries)("%s hides only the redundant selector and retains legacy acceptance", (name, backend) => {
        const accepted = ALL_TOOLS.find((tool: any) => tool.name === name)!.inputSchema;
        const publicSchema = TOOLS.find((tool: any) => tool.name === name)!.inputSchema;
        expect(accepted.properties.backend).toMatchObject({ type: "string", enum: [backend] });
        expect(accepted.required).toContain("backend");
        const expected = structuredClone(accepted);
        delete expected.properties.backend;
        expected.required = expected.required.filter((key: string) => key !== "backend");
        expect(publicSchema).toEqual(expected);
    });
    it.each(entries)("%s defaults omission and preserves explicit selectors and top-level precedence", async (name, backend) => {
        for (const selector of [{}, { backend: undefined }, { backend }, { options: { backend } }, { backend, options: { backend: "wrong" } }]) {
            fixture.calls.length = 0;
            const input = { deviceId: "owned-target", implicitBroker: false, confirmDestructive: true, ...selector };
            const original = structuredClone(input);
            expect(normalizeToolArgs(input, name).backend).toBe(backend);
            await call(name, input);
            expect(fixture.calls.length).toBeGreaterThan(0);
            expect(fixture.calls.every((entry) => entry.args.backend === backend)).toBe(true);
            expect(fixture.calls.at(-1)?.provider).toBe(backend === "macos-vm" ? "macos" : name.startsWith("device_image_") ? "linux-management" : "linux");
            expect(input).toEqual(original);
        }
    });
    it.each(entries)("%s rejects contradictory, null, empty and malformed selectors before any provider", async (name, backend) => {
        for (const wrong of [backend === "linux-vm" ? "macos-vm" : "linux-vm", "", null, false, 7, [], {}]) {
            for (const selector of [{ backend: wrong }, { options: { backend: wrong } }, { backend: wrong, options: { backend } }]) {
                fixture.calls.length = 0;
                const input = { deviceId: "owned-target", implicitBroker: false, confirmDestructive: true, ...selector };
                expect(normalizeToolArgs(input, name).backend).toEqual(wrong);
                const result = await call(name, input);
                expect(result.isError).toBe(true);
                expect(parse(result)).toMatchObject({ ok: false, error: "device-backend-unsupported" });
                expect(fixture.calls).toEqual([]);
            }
        }
    });
    it("does not default unrelated tools, and keeps creation wrappers compatible", () => {
        expect(normalizeToolArgs({ deviceId: "a" }, "device_status")).toEqual({ deviceId: "a" });
        expect(normalizeToolArgs({}, "unknown")).toEqual({});
        expect(normalizeToolArgs({ options: { backend: "linux-vm", name: "old", cpus: 4 }, name: "new", detail: true }, "device_create"))
            .toEqual({ backend: "linux-vm", name: "new", cpus: 4 });
        expect(TOOLS.find((tool: any) => tool.name === "device_create")!.inputSchema.properties).not.toHaveProperty("options");
        expect(ALL_TOOLS.find((tool: any) => tool.name === "device_create")!.inputSchema.properties.options).toMatchObject({ type: "object" });
    });
    it("merges flow target groups before supplying selected-tool defaults", () => {
        const shared = { deviceId: "a", backend: "macos-vm", incarnationId: "a".repeat(32) };
        expect(flowStepArguments("device_guest_agent_status", shared, {})).toMatchObject({ deviceId: "a", backend: "macos-vm" });
        expect(normalizeToolArgs(flowStepArguments("device_guest_agent_status", shared, { deviceId: "b" }), "device_guest_agent_status")).toEqual({ deviceId: "b", backend: "linux-vm" });
        expect(flowStepArguments("device_guest_agent_status", shared, { backend: "linux-vm" })).toEqual({ backend: "linux-vm" });
        expect(flowStepArguments("device_guest_agent_status", shared, { options: { deviceId: "b", backend: null } })).toEqual({ deviceId: "b", backend: null });
    });
});

// Child stdio processes load real providers; parent mocks above cannot affect them.
describe("single-backend QEMU owner isolation through MCP", () => {
    let context: Awaited<ReturnType<typeof createDeviceLabMcpTestContext>>;
    let root: string;
    let ownedMetadata: string;
    let foreignMetadata: string;
    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext({ env: { CCC_PROFILE: "input-clarity" } });
        const result = parse(await context.client.callTool({ name: "device_create", arguments: { backend: "linux-vm", name: "Owned Target" } }));
        expect(result.ok).toBe(true);
        // Read the authoritative root from the real provider instead of assuming its storage layout.
        const inventory = parse(await context.client.callTool({ name: "device_inventory", arguments: { backend: "linux-vm" } }));
        root = inventory.discovery.stateRoot;
        ownedMetadata = join(root, "owners", result.device.ownerId, "labs", "owned-target", "lab.json");
        const foreignEnv = { CCC_PROFILE: "input-clarity-foreign", CCC_DEVICE_LAB_OWNER_BASIS: "foreign-owner" };
        const foreign = createLab({ name: "Foreign Target" }, { env: foreignEnv, stateRoot: root });
        expect(foreign.ok).toBe(true);
        foreignMetadata = join(root, "owners", ownerId(foreignEnv), "labs", "foreign-target", "lab.json");
    });
    afterAll(async () => { await cleanupDeviceLabMcpTestContext(context); });
    it("creates from legacy options with top-level precedence and imports an image without backend", async () => {
        const created = parse(await context.client.callTool({ name: "device_create", arguments: {
            options: { backend: "linux-vm", name: "ignored-name", cpus: 2, memoryMb: 512 }, name: "Legacy Options", cpus: 3,
        } }));
        expect(created.ok).toBe(true);
        const metadata = JSON.parse(readFileSync(join(root, "owners", created.device.ownerId, "labs", "legacy-options", "lab.json"), "utf8"));
        expect(metadata.resources).toMatchObject({ cpus: 3, memoryMb: 512 });
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "base.qcow2"), "fixture-image");
        const imported = parse(await context.client.callTool({ name: "device_image_import", arguments: { name: "Input Base", sourcePath: "incoming/base.qcow2" } }));
        expect(imported).toMatchObject({ ok: true, image: { id: "input-base" } });
        const listed = parse(await context.client.callTool({ name: "device_image_list", arguments: {} }));
        expect(listed).toMatchObject({ ok: true, images: expect.arrayContaining([expect.objectContaining({ id: "input-base" })]) });
    });
    it.each(ownedActions)("%s rejects wrong selectors without changing owned QEMU metadata", async (name) => {
        const before = readFileSync(ownedMetadata, "utf8");
        for (const backend of ["macos-vm", null, ""]) {
            const result = await context.client.callTool({ name, arguments: { deviceId: "owned-target", backend } });
            expect(result.isError).toBe(true);
            expect(parse(result)).toMatchObject({ error: "device-backend-unsupported" });
            expect(readFileSync(ownedMetadata, "utf8")).toBe(before);
        }
    });
    it.each(ownedActions)("%s does not find another owner's or missing target when backend is omitted", async (name) => {
        const before = readFileSync(foreignMetadata, "utf8");
        for (const deviceId of ["foreign-target", "missing-target"]) {
            const result = await context.client.callTool({ name, arguments: { deviceId } });
            expect(result.isError).toBe(true);
            expect(parse(result)).toMatchObject({ ok: false, error: "lab-not-found" });
        }
        expect(readFileSync(foreignMetadata, "utf8")).toBe(before);
    });
    it("never consults a host Hyper-V broker for host-only or duplicate target IDs", async () => {
        const requests: string[] = [];
        const server = createServer((req, res) => {
            requests.push(req.url || "");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, result: { devices: [
                { id: "host-only", backend: "linux-vm", provider: "hyper-v" },
                { id: "owned-target", backend: "linux-vm", provider: "hyper-v" },
            ] } }));
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const port = (server.address() as { port: number }).port;
            for (const name of ownedActions) {
                const result = await context.client.callTool({ name, arguments: {
                    deviceId: "host-only", broker: true, hostCandidates: ["127.0.0.1"], port,
                } });
                expect(result.isError).toBe(true);
                expect(parse(result)).toMatchObject({ error: "lab-not-found" });
            }
            const duplicate = parse(await context.client.callTool({ name: "device_session_open", arguments: {
                deviceId: "owned-target", sessionType: "metadata", broker: true, hostCandidates: ["127.0.0.1"], port,
            } }));
            expect(duplicate.ok).toBe(true);
            expect(duplicate.session.authority).toBe("device-lab-metadata");
            expect(requests).toEqual([]);
        } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
    it("preserves corrupt target failure without rewriting corrupt state", async () => {
        const path = join(root, "owners", JSON.parse(readFileSync(ownedMetadata, "utf8")).ownerId, "labs", "corrupt-target", "lab.json");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "{broken");
        await expect(context.client.callTool({ name: "device_readiness_probe", arguments: { deviceId: "corrupt-target" } }))
            .rejects.toThrow(/JSON|parse|corrupt|invalid/i);
        expect(readFileSync(path, "utf8")).toBe("{broken");
    });
});
