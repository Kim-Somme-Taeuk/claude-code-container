import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_BROKER_PROTOCOL_VERSION, isCompatibleBrokerProtocol } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { probeCccHostBrokerProtocolForTest } from "../../device-lab-mcp/src/broker.mjs";
import { createDeviceBrokerServer, ensureHostDeviceBroker } from "@ccc/device-lab/device-lab-broker.js";
import { readDeviceRuntimeProcessStartToken } from "@ccc/device-lab/device-lab-process-identity.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

describe("one broker protocol", () => {
    it.each([undefined, null, String(DEVICE_BROKER_PROTOCOL_VERSION), true, 0, DEVICE_BROKER_PROTOCOL_VERSION - 1, DEVICE_BROKER_PROTOCOL_VERSION + 1, NaN, {}, []])("rejects absent, malformed or different protocol %s", (value) => {
        expect(isCompatibleBrokerProtocol(value)).toBe(false);
    });
    it.each([undefined, 0, 1, 2, "1"])("checks protocol over actual HTTP: %s", async (protocolVersion) => {
        const server = createServer((_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ok: true, broker: {protocolVersion, version: "999.0.0"}}));
        });
        const url = await listen(server);
        try {
            const result = await probeCccHostBrokerProtocolForTest("127.0.0.1", Number(new URL(url).port), 3000);
            expect(result.ok).toBe(protocolVersion === DEVICE_BROKER_PROTOCOL_VERSION);
            expect(result.expectedProtocolVersion).toBe(DEVICE_BROKER_PROTOCOL_VERSION);
            expect(result).not.toHaveProperty("missingCapabilities");
        } finally { await close(server); }
    });
});

describe("host CLI protocol reuse", () => {
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-broker-capabilities-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it.each([DEVICE_BROKER_PROTOCOL_VERSION, DEVICE_BROKER_PROTOCOL_VERSION + 1])("reuses matching protocol and never downgrades newer protocol %s", async (protocolVersion) => {
        const cwd = "/project/broker-newer-family-reuse-test";
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const response = await realFetch(input, init);
            if (!String(input).endsWith("/status")) return response;
            const body = await response.json() as { broker: { version: string; protocolVersion: number } };
            body.broker.version = "999.0.0";
            body.broker.protocolVersion = protocolVersion;
            return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        });
        // The listener is this test process. Were the broker judged incompatible, the CLI would
        // signal it for replacement; record that instead of letting it kill the test worker.
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const commandLine = `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`;
        const processStartToken = readDeviceRuntimeProcessStartToken(process.pid) || `test:${process.pid}`;
        try {
            const spawnImpl = vi.fn();
            const terminateProcess = vi.fn(() => { throw new Error("compatible/newer broker must not be terminated"); });
            const result = await ensureHostDeviceBroker({
                terminateProcess,
                timeoutMs: 10000,
                cwd,
                bindHost: "127.0.0.1",
                probeHost: "127.0.0.1",
                port,
                cliPath: "/opt/ccc/dist/index.js",
                portProcessResolver: () => ({
                    pid: process.pid,
                    commandLine,
                    processIdentity: {
                        pid: process.pid,
                        startToken: processStartToken,
                        commandHash: createHash("sha256").update(commandLine).digest("hex"),
                    },
                    processStartToken,
                }),
                spawnImpl: spawnImpl as any,
            });

            if (protocolVersion === DEVICE_BROKER_PROTOCOL_VERSION) {
                expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: true, launched: false, reused: true, port }));
                expect(result).toHaveProperty("verifiedProtocolVersion", DEVICE_BROKER_PROTOCOL_VERSION);
            } else {
                expect(result, JSON.stringify(result)).toEqual(expect.objectContaining({ ok: false, error: "host-broker-incompatible" }));
            }
            expect(terminateProcess).not.toHaveBeenCalled();
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
        } finally {
            await close(server);
        }
    });
});
