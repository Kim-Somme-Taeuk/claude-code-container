import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";
import { cleanupFakeAndroidMcpContext, createFakeAndroidMcpContext } from "./helpers/fake-android-mcp-fixture.js";
import { cleanupFakeIosMcpContext, createFakeIosMcpContext } from "./helpers/fake-ios-mcp-fixture.js";

function text(result: any): string { return result.content[0].text; }
function json(result: any) { return JSON.parse(text(result)); }

const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
    ["mobile_key", {}, /mobile_key requires key or keyCode/],
    ["mobile_key", { key: "" }, /mobile_key requires key or keyCode/],
    ["mobile_key", { key: null }, /mobile_key requires key or keyCode/],
    ["mobile_key", { key: {} }, /mobile_key requires key or keyCode/],
    ["mobile_key", { keyCode: false }, /mobile_key requires key or keyCode/],
    ["mobile_wait_for_text", {}, /mobile_wait_for_text requires text/],
    ["mobile_wait_for_text", { text: "" }, /mobile_wait_for_text requires text/],
    ["mobile_wait_for_text", { text: 7 }, /mobile_wait_for_text requires text/],
    ["mobile_wait_for_text", { text: [] }, /mobile_wait_for_text requires text/],
    ["mobile_key", { options: { key: "" } }, /mobile_key requires key or keyCode/],
    ["mobile_wait_for_text", { options: { text: "" } }, /mobile_wait_for_text requires text/],
];

describe("mobile input preflight over public MCP", () => {
    it.each(["direct", "explicit", "implicit"])("rejects invalid %s actions and flow steps before any subprocess or network work", { timeout: 30000 }, async (route) => {
        const env: Record<string, string> = {};
        let log = "";
        const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
            log = join(home, "preparation.jsonl");
            writeFileSync(log, "");
            const preload = join(home, "trace-preparation.cjs");
            writeFileSync(preload, `const fs=require('fs'),cp=require('child_process');
const record=(kind,args)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,args})+'\\n');
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){const original=cp[key];cp[key]=function(...args){record(key,args.slice(0,2));return original.apply(this,args)}}
globalThis.fetch=async(...args)=>{record('fetch',args);throw new Error('preflight fixture: unexpected network work')};
require('module').syncBuiltinESMExports();`);
            env.NODE_OPTIONS = `--require=${JSON.stringify(join(home, "isolate-broker-auth.cjs"))} --require=${JSON.stringify(preload)}`;
        } });
        try {
            const routing = { backend: "android-emulator", deviceId: "android-preflight", autolaunch: false,
                hostCandidates: ["127.0.0.1"], timeoutMs: 1,
                ...(route === "direct" ? { implicitBroker: false } : route === "explicit" ? { broker: true } : { implicitBroker: true }) };
            for (const flow of [null, "mobile_run_flow", "device_run_flow"]) {
                for (const [tool, args, diagnostic] of invalid) {
                    writeFileSync(log, "");
                    const action = { ...routing, ...args };
                    const result = await context.client.callTool({ name: flow || tool,
                        arguments: flow ? { steps: [{ tool, arguments: action }] } : action });
                    const label = `${route}/${flow || "standalone"}/${tool}/${JSON.stringify(args)}`;
                    expect(readFileSync(log, "utf8"), label).toBe("");
                    expect(text(result), label).toMatch(diagnostic);
                    if (flow) expect(json(result), label).toMatchObject({ ok: false, stoppedAt: 0, results: [{ tool, isError: true }] });
                    else expect(result.isError, label).toBe(true);
                }
            }
            // Prove the trace observes real preparation when valid input proceeds.
            writeFileSync(log, "");
            await context.client.callTool(route === "direct"
                ? { name: "device_backends", arguments: { implicitBroker: false } }
                : { name: "mobile_key", arguments: { ...routing, keyCode: 0 } });
            expect(readFileSync(log, "utf8")).not.toBe("");
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });

    it("advertises either key alternative and nonempty string inputs", async () => {
        const context = await createDeviceLabMcpTestContext();
        try {
            const catalog = await context.client.listTools();
            const ajv = new Ajv({ strict: false });
            const keySchema = catalog.tools.find((tool) => tool.name === "mobile_key")!.inputSchema;
            expect(keySchema.anyOf).toBeDefined();
            const key = ajv.compile(keySchema);
            for (const args of [{ key: "Return" }, { keyCode: 0 }, { key: "Return", keyCode: 4 }, { key: " " }]) {
                expect(key({ deviceId: "android-test", ...args }), JSON.stringify(args)).toBe(true);
            }
            for (const args of [{}, { key: "" }, { key: {} }, { keyCode: false }]) {
                expect(key({ deviceId: "android-test", ...args }), JSON.stringify(args)).toBe(false);
            }
            const wait = ajv.compile(catalog.tools.find((tool) => tool.name === "mobile_wait_for_text")!.inputSchema);
            expect(wait({ deviceId: "android-test", text: " " })).toBe(true);
            for (const args of [{}, { text: "" }, { text: 7 }]) expect(wait({ deviceId: "android-test", ...args })).toBe(false);
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });

    it("preserves zero, legacy options, whitespace and Android mixed-field precedence", { timeout: 30000 }, async () => {
        const context = await createFakeAndroidMcpContext();
        try {
            const created = await context.client.callTool({ name: "device_create", arguments: {
                backend: "android-emulator", name: "Preflight", avdName: "Preflight", port: 5582,
            } });
            expect(created.isError).not.toBe(true);
            const deviceId = json(created).device.id;
            for (const [args, expected] of [
                [{ keyCode: 0 }, 0], [{ key: "KEYCODE_ENTER" }, "KEYCODE_ENTER"],
                [{ key: "KEYCODE_ENTER", keyCode: 4 }, 4],
                [{ key: "", keyCode: 0 }, 0],
                [{ options: { keyCode: 0 } }, 0],
                [{ options: { keyCode: 4 }, keyCode: 0 }, 0],
            ] as const) {
                const result = await context.client.callTool({ name: "mobile_key", arguments: { deviceId, ...args } });
                expect(result.isError, text(result)).not.toBe(true);
                expect(json(result)).toMatchObject({ key: expected, provider: "adb" });
            }
            const wait = await context.client.callTool({ name: "mobile_wait_for_text", arguments: {
                deviceId, options: { text: " " }, timeoutMs: 1000, intervalMs: 50,
            } });
            expect(wait.isError, text(wait)).not.toBe(true);
            expect(json(wait)).toMatchObject({ text: " ", provider: "adb-uiautomator" });
        } finally { await cleanupFakeAndroidMcpContext(context); }
    });

    it("preserves iOS key preference when both alternatives are present", { timeout: 30000 }, async () => {
        const context = await createFakeIosMcpContext();
        try {
            const created = await context.client.callTool({ name: "device_create", arguments: {
                backend: "ios-simulator", name: "Preflight", deviceId: "ios-preflight",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0", createSimulator: true,
            } });
            expect(created.isError, text(created)).not.toBe(true);
            const started = await context.client.callTool({ name: "device_start", arguments: { deviceId: "ios-preflight", bootTimeoutMs: 1000 } });
            expect(started.isError, text(started)).not.toBe(true);
            const result = await context.client.callTool({ name: "mobile_key", arguments: { deviceId: "ios-preflight", key: "Return", keyCode: 4 } });
            expect(result.isError, text(result)).not.toBe(true);
            expect(json(result)).toMatchObject({ key: "Return", provider: "appium-xcuitest" });
            expect(readFileSync(context.logPath, "utf8")).toContain('"text":"Return","value":["Return"]');
        } finally { await cleanupFakeIosMcpContext(context); }
    });
});
