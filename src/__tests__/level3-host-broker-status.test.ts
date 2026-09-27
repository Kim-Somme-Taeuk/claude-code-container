import { describe, expect, it } from "vitest";

import { HYPER_V_ELEVATED_NETWORK_ERROR_CODES } from "../device-lab/broker/hyper-v/elevated-network-session.js";
import { deviceBrokerStatus } from "../device-lab-broker.js";
import { probeHostBrokerCapabilities } from "../../scripts/real-tests/support/level3-host.js";

// Here rather than beside the other Level 3 launcher tests in scripts/real-tests: this one loads the
// broker, and tsconfig.real-tests.json typechecks that directory without strict null checks, which
// the broker's narrowing does not survive.
describe("Level 3 host broker status contract", () => {
    const status = (broker: unknown) => probeHostBrokerCapabilities(17373, {
        fetchImpl: async () => new Response(JSON.stringify({ ok: true, broker }), { status: 200 }),
    });

    it("reads the elevation gate where the broker's /status reports it", async () => {
        // If the field moved, the probe would call every broker unreported and Level 3 would never
        // stop a run whose broker has already refused.
        const observed = await status(deviceBrokerStatus({ ownerId: "level3-host-gate-contract" }));

        expect(observed).toMatchObject({ ok: true, elevationGate: { state: "never-asked" } });
    });

    it("names every refusal code the broker can record instead of bounding it away", async () => {
        const broker = deviceBrokerStatus({ ownerId: "level3-host-gate-contract" });
        for (const code of HYPER_V_ELEVATED_NETWORK_ERROR_CODES) {
            const observed = await status({
                ...broker,
                hyperVElevationGate: { state: "refused", code, at: new Date(0).toISOString() },
            });
            expect(observed).toMatchObject({
                ok: true,
                elevationGate: { state: "refused", code, at: "1970-01-01T00:00:00.000Z" },
            });
        }
    });
});
