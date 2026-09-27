import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    brokerCapabilitySatisfied,
    missingBrokerCapabilities,
    parseBrokerCapability,
} from "../../device-lab-mcp/src/contracts/broker-capabilities.mjs";
import {
    probeCccHostBrokerCapabilitiesForTest,
    REQUIRED_CCC_HOST_BROKER_CAPABILITIES,
} from "../../device-lab-mcp/src/broker.mjs";
import {
    createDeviceBrokerServer,
    DEVICE_BROKER_IMPLEMENTED_CAPABILITIES,
    ensureHostDeviceBroker,
} from "../device-lab-broker.js";
import { readDeviceRuntimeProcessStartToken } from "../device-lab-process-identity.js";
import {
    ensureHostBrokerReady,
    HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
} from "../../scripts/real-tests/support/level3-host.js";
import { close, listen } from "./helpers/host-broker-test-fixture.js";

// Moves every versioned family by `delta` (+1: a newer broker, -1: an older one) and leaves
// unversioned capabilities untouched.
function shiftFamilies(capabilities: readonly string[], delta: number): string[] {
    return capabilities.map((capability) => {
        const parsed = parseBrokerCapability(capability);
        return parsed.version === null ? capability : `${parsed.family}-v${Math.max(0, parsed.version + delta)}`;
    });
}

async function serveStatus(implemented: unknown[]): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/status") {
            res.end(JSON.stringify({ ok: true, broker: { implemented } }));
            return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(server: Server) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("broker capability family matching", () => {
    it("parses versioned families and treats everything else as an exact-match capability", () => {
        expect(parseBrokerCapability("hyper-v-setup-network-v10")).toEqual({ family: "hyper-v-setup-network", version: 10 });
        expect(parseBrokerCapability("hyper-v-windows-library-v16")).toEqual({ family: "hyper-v-windows-library", version: 16 });
        expect(parseBrokerCapability("http-owner-rpc")).toEqual({ family: "http-owner-rpc", version: null });
        expect(parseBrokerCapability("hyper-v")).toEqual({ family: "hyper-v", version: null });
        expect(parseBrokerCapability("trailing-v")).toEqual({ family: "trailing-v", version: null });
        // An unsafe integer cannot be compared reliably, so it degrades to exact matching.
        expect(parseBrokerCapability("huge-v99999999999999999999")).toEqual({ family: "huge-v99999999999999999999", version: null });
    });

    it("lets a newer family version satisfy an older requirement but never the reverse", () => {
        expect(brokerCapabilitySatisfied("hyper-v-network-failure-diagnostics-v9", ["hyper-v-network-failure-diagnostics-v10"])).toBe(true);
        expect(brokerCapabilitySatisfied("hyper-v-network-failure-diagnostics-v10", ["hyper-v-network-failure-diagnostics-v10"])).toBe(true);
        expect(brokerCapabilitySatisfied("hyper-v-network-failure-diagnostics-v10", ["hyper-v-network-failure-diagnostics-v9"])).toBe(false);
        // The newest advertised version of a family is what counts, whatever else is listed.
        expect(brokerCapabilitySatisfied("hyper-v-setup-network-v10", ["hyper-v-setup-network-v3", "hyper-v-setup-network-v12"])).toBe(true);
    });

    it("keeps family boundaries and unversioned capabilities exact", () => {
        expect(brokerCapabilitySatisfied("hyper-v-setup-network-v10", ["hyper-v-setup-v11"])).toBe(false);
        expect(brokerCapabilitySatisfied("hyper-v-setup-network-v10", ["hyper-v-setup-network-extra-v11"])).toBe(false);
        expect(brokerCapabilitySatisfied("http-owner-rpc", ["http-owner-rpc-v2"])).toBe(false);
        expect(brokerCapabilitySatisfied("owner-token-guard-v1", ["owner-token-guard"])).toBe(false);
        expect(brokerCapabilitySatisfied("http-owner-rpc", ["http-owner-rpc"])).toBe(true);
    });

    it("reports only the truly unsatisfied requirements, in required order", () => {
        expect(missingBrokerCapabilities(
            ["http-owner-rpc", "a-family-v3", "b-family-v5", "c-family-v1", "unversioned-extra"],
            ["http-owner-rpc", "a-family-v4", "b-family-v4", "c-family-v1"],
        )).toEqual(["b-family-v5", "unversioned-extra"]);
        expect(missingBrokerCapabilities(["a-v1"], null)).toEqual(["a-v1"]);
        expect(missingBrokerCapabilities(null, ["a-v1"])).toEqual([]);
    });

    it("accepts the newer host broker that the previous MCP release rejected in the field", () => {
        // Observed on a Windows host: the container's MCP image required these three and the host
        // broker advertised the next generation of each, so every device tool was refused.
        const olderClientRequirements = [
            "hyper-v-linux-x11-type-v1",
            "hyper-v-provider-image-finalization-v39",
            "hyper-v-network-failure-diagnostics-v9",
        ];
        const newerBroker = [
            "hyper-v-linux-x11-type-v2",
            "hyper-v-provider-image-finalization-v40",
            "hyper-v-network-failure-diagnostics-v10",
        ];
        expect(missingBrokerCapabilities(olderClientRequirements, newerBroker)).toEqual([]);
        expect(missingBrokerCapabilities(newerBroker, olderClientRequirements)).toEqual(newerBroker);
    });
});

describe("MCP host broker capability probe", () => {
    it("treats a broker one generation ahead on every family as compatible", async () => {
        const { server, port } = await serveStatus(shiftFamilies(REQUIRED_CCC_HOST_BROKER_CAPABILITIES, 1));
        try {
            const result = await probeCccHostBrokerCapabilitiesForTest("127.0.0.1", port, 3000);
            expect(result).toEqual(expect.objectContaining({ ok: true, missingCapabilities: [] }));
        } finally {
            await closeServer(server);
        }
    });

    it("still rejects a broker one generation behind and names only the stale families", async () => {
        // Relative to the current requirement, so a later family bump does not break this test.
        const required = REQUIRED_CCC_HOST_BROKER_CAPABILITIES.find((capability: string) =>
            parseBrokerCapability(capability).family === "hyper-v-setup-network") as string;
        const [previous] = shiftFamilies([required], -1);
        const stale = REQUIRED_CCC_HOST_BROKER_CAPABILITIES.filter((capability: string) => capability !== required);
        const { server, port } = await serveStatus([...stale, previous]);
        try {
            const result = await probeCccHostBrokerCapabilitiesForTest("127.0.0.1", port, 3000);
            expect(result).toEqual(expect.objectContaining({
                ok: false,
                missingCapabilities: [required],
            }));
        } finally {
            await closeServer(server);
        }
    });
});

describe("host CLI broker reuse with newer capability families", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-broker-capabilities-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    it("reuses a same-version broker that advertises newer capability families instead of downgrading it", async () => {
        const cwd = "/project/broker-newer-family-reuse-test";
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0 });
        const baseUrl = await listen(server);
        const port = Number(new URL(baseUrl).port);
        // Rewrite only the advertised capability list; version, identity and owner resolution stay
        // the real broker's, so the only thing under test is the capability comparison.
        const realFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const response = await realFetch(input, init);
            if (!String(input).endsWith("/status")) return response;
            const body = await response.json() as { broker: { implemented: string[] } };
            body.broker.implemented = shiftFamilies(body.broker.implemented, 1);
            return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        });
        // The listener is this test process. Were the broker judged incompatible, the CLI would
        // signal it for replacement; record that instead of letting it kill the test worker.
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        const commandLine = `node /opt/ccc/dist/index.js devices broker serve --host 127.0.0.1 --port ${port}`;
        const processStartToken = readDeviceRuntimeProcessStartToken(process.pid) || `test:${process.pid}`;
        try {
            const spawnImpl = vi.fn();
            const result = await ensureHostDeviceBroker({
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

            expect(result).toEqual(expect.objectContaining({ ok: true, launched: false, reused: true, port }));
            expect(spawnImpl).not.toHaveBeenCalled();
            expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
            const advertised = (result as { verifiedCapabilities?: string[] }).verifiedCapabilities || [];
            expect(advertised).toContain("hyper-v-linux-x11-type-v3");
            expect(advertised).not.toContain("hyper-v-linux-x11-type-v2");
            expect(DEVICE_BROKER_IMPLEMENTED_CAPABILITIES).toContain("hyper-v-linux-x11-type-v2");
        } finally {
            await close(server);
        }
    });
});

describe("level-3 host broker attestation with newer capability families", () => {
    const verifiedBrokerPid = 4321;
    const verifiedBrokerStartedAt = "2026-07-28T00:00:00.000Z";

    function statusOutput(capabilities: readonly string[]) {
        return [
            "port: 17373",
            "brokerReady: true",
            `brokerVerifiedCapabilities: ${capabilities.join(", ")}`,
            `brokerVerifiedPid: ${verifiedBrokerPid}`,
            `brokerVerifiedStartedAt: ${verifiedBrokerStartedAt}`,
        ].join("\n");
    }

    async function attest(capabilities: readonly string[]) {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        const originalStdoutWrite = process.stdout.write;
        process.stderr.write = ((chunk: unknown) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        process.stdout.write = (() => true) as typeof process.stdout.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({ status: 0, stdout: statusOutput(capabilities), stderr: "" }),
                probeHostBrokerCapabilitiesImpl: async () => ({
                    ok: true,
                    capabilities,
                    pid: verifiedBrokerPid,
                    startedAt: verifiedBrokerStartedAt,
                }),
            });
            return { status, diagnostic };
        } finally {
            process.stderr.write = originalWrite;
            process.stdout.write = originalStdoutWrite;
        }
    }

    it("attests a broker one generation ahead, agreeing with the CLI that reused it", async () => {
        const result = await attest(shiftFamilies(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES, 1));
        expect(result).toEqual({ status: 0, diagnostic: "" });
    });

    it("still refuses a broker one generation behind", async () => {
        const result = await attest(shiftFamilies(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES, -1));
        expect(result.status).toBe(1);
        expect(result.diagnostic).toContain("capability attestation failed");
    });
});
