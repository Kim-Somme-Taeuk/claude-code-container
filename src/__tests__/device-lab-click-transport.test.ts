import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { createDeviceLabMcpTestContext, cleanupDeviceLabMcpTestContext, repoRoot } from "./helpers/device-lab-mcp-fixture.js";

describe("actual MCP click transport", () => {
    it.each(["device-lab-mcp/server.mjs", "dist/device-lab-mcp/server.mjs"])("preserves selectors over %s stdio and broker HTTP", { timeout: 30000 }, async entry => {
        const context = await createDeviceLabMcpTestContext({ serverPath: join(repoRoot, entry), defaultImplicitBroker: true });
        const owner = deviceLabOwnerId(repoRoot);
        const secret = "c".repeat(64);
        const token = createHash("sha256").update(`ccc-device-broker:owner:${owner}:secret:${secret}`).digest("hex");
        const auth = join(context.homeDir, ".ccc/devices/broker/auth");
        mkdirSync(auth, { recursive: true });
        writeFileSync(join(auth, `${owner}.json`), JSON.stringify({ ownerId: owner, secret, version: 1 }), { mode: 0o600 });
        const received: any[] = [];
        const server = createServer((req, res) => {
            const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
            if (req.url === "/health") return send({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" });
            if (req.url === "/status") return send({ ok: true, name: "ccc-device-broker", mode: "host-broker-daemon", broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } });
            if (req.url === "/v1/owner/resolve") return send({ ok: true, result: { ownerId: owner } });
            if (req.headers["x-ccc-device-token"] !== token) return send({ ok: false, error: "unauthorized" }, 401);
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const call = JSON.parse(body);
                if (call.method === "broker.inventory") return send({ ok: true, result: { backends: [
                    { backend: "android-emulator", stateKey: "android", devices: [{ id: "phone", backend: "android-emulator" }] },
                    { backend: "windows-sandbox", stateKey: "windows", devices: [{ id: "desktop", backend: "windows-sandbox" }] },
                ] } });
                if (call.method !== "broker.device.tool.invoke") return send({ ok: false, error: "unexpected-method" }, 400);
                received.push(call.params);
                const fields: Record<string, string> = { device_click: "clicked", device_double_click: "doubleClicked", mobile_tap: "tapped", mobile_double_tap: "doubleTapped" };
                const field = fields[call.params.tool];
                if (!field) return send({ ok: false, error: "unexpected-operation" }, 400);
                send({ ok: true, result: { mcpResult: { content: [{ type: "text", text: JSON.stringify({ provider: "fixture", [field]: { x: 30, y: 30 } }) }] } } });
            });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const route = { autolaunch: false, hostCandidates: ["127.0.0.1"], port: (server.address() as AddressInfo).port };
        try {
            for (const deviceId of ["phone", "desktop"]) {
                for (const count of [undefined, 1, 2]) {
                    for (const detail of [false, true]) {
                        const result: any = await context.client.callTool({ name: "click", arguments: { ...route, deviceId, x: 30, y: 30, detail, ...(count === undefined ? {} : { count }) } });
                        expect(result.isError, JSON.stringify(result)).not.toBe(true);
                        const expected = deviceId === "phone" ? (count === 2 ? "mobile_double_tap" : "mobile_tap") : (count === 2 ? "device_double_click" : "device_click");
                        expect(received.at(-1)?.tool).toBe(expected);
                        expect(received.at(-1)).not.toHaveProperty("count");
                        if (!detail) expect(result.content).toEqual([{ type: "text", text: "ok" }]);
                        else {
                            const field = deviceId === "phone" ? (count === 2 ? "doubleTapped" : "tapped") : (count === 2 ? "doubleClicked" : "clicked");
                            expect(JSON.parse(result.content[0].text)[field]).toEqual({ x: 30, y: 30 });
                        }
                    }
                }
                const flow: any = await context.client.callTool({ name: "run_flow", arguments: { detail: true, deviceId, steps: [{ tool: "click", arguments: { ...route, x: 30, y: 30, count: 2 } }] } });
                expect(flow.isError, JSON.stringify(flow)).not.toBe(true);
                expect(received.at(-1)?.tool).toBe(deviceId === "phone" ? "mobile_double_tap" : "device_double_click");
            }
            expect(received).toHaveLength(14);
        } finally {
            await cleanupDeviceLabMcpTestContext(context);
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
