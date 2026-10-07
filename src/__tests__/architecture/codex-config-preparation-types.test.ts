import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { createCodexConfigPreparation } from "../../application/codex-config-preparation.js";
import type { CodexConfigPreparationPorts } from "../../ports/codex-config-preparation.js";

// Rejected capabilities are checked by TypeScript, never executed.
function compileContracts(ports: CodexConfigPreparationPorts, native: SpawnSyncReturns<Buffer>) {
    const app = createCodexConfigPreparation(ports);
    const ran: undefined = app.run("target");
    const status: number | null = ports.probe("target").status;
    const error: unknown = ports.repair("target").error;
    createCodexConfigPreparation({ probe: () => native, repair: () => native, finalize: () => native });
    createCodexConfigPreparation({ ...ports, probe: () => ({ status: null, error: Symbol("opaque") }) });
    void [ran, status, error];
    // @ts-expect-error Required ports cannot be omitted.
    createCodexConfigPreparation();
    // @ts-expect-error Undefined cannot supply ports.
    createCodexConfigPreparation(undefined);
    // @ts-expect-error Probe is required.
    createCodexConfigPreparation({ repair: ports.repair, finalize: ports.finalize });
    // @ts-expect-error Repair is required.
    createCodexConfigPreparation({ probe: ports.probe, finalize: ports.finalize });
    // @ts-expect-error Finalize is required.
    createCodexConfigPreparation({ probe: ports.probe, repair: ports.repair });
    // @ts-expect-error Probe must be callable.
    createCodexConfigPreparation({ ...ports, probe: false });
    // @ts-expect-error Repair must be callable.
    createCodexConfigPreparation({ ...ports, repair: {} });
    // @ts-expect-error Finalize must be callable.
    createCodexConfigPreparation({ ...ports, finalize: undefined });
    // @ts-expect-error Probe observations must be synchronous.
    createCodexConfigPreparation({ ...ports, probe: async () => ({ status: 0 }) });
    // @ts-expect-error Repair observations must be synchronous.
    createCodexConfigPreparation({ ...ports, repair: async () => ({ status: 0 }) });
    // @ts-expect-error Finalize observations must be synchronous.
    createCodexConfigPreparation({ ...ports, finalize: async () => ({ status: 0 }) });
    // @ts-expect-error Probe requires a status.
    createCodexConfigPreparation({ ...ports, probe: () => ({ error: undefined }) });
    // @ts-expect-error Repair status cannot be a string.
    createCodexConfigPreparation({ ...ports, repair: () => ({ status: "0" }) });
    // @ts-expect-error Finalize status cannot be undefined.
    createCodexConfigPreparation({ ...ports, finalize: () => ({ status: undefined }) });
    // @ts-expect-error Void is not an observation.
    createCodexConfigPreparation({ ...ports, repair: (): void => {} });
    // @ts-expect-error Run requires a target.
    app.run();
    // @ts-expect-error Run requires a string target.
    app.run(1);
    // @ts-expect-error Probe requires a string target.
    ports.probe(1);
    // @ts-expect-error Repair requires a target.
    ports.repair();
    // @ts-expect-error Finalize requires a string target.
    ports.finalize(null);
    // @ts-expect-error Run completes synchronously.
    const promise: Promise<undefined> = app.run("target");
    // @ts-expect-error Run does not return a success flag.
    const success: boolean = app.run("target");
    void [promise, success];
}
void compileContracts;

describe("Codex config preparation compile contracts", () => {
    it("returns synchronous undefined", () => {
        const app = createCodexConfigPreparation({ probe: () => ({ status: 0 }), repair: () => ({ status: 0 }), finalize: () => ({ status: 0 }) });
        expect(app.run("target")).toBeUndefined();
    });
});
