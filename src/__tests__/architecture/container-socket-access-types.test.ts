import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { createContainerSocketAccess } from "../../application/container-socket-access.js";
import type { ContainerSocketAccessPorts } from "../../ports/container-socket-access.js";

// Negative contracts are compiled but never invoked.
function compileContracts(ports: ContainerSocketAccessPorts, native: SpawnSyncReturns<string>) {
    const app = createContainerSocketAccess(ports);
    const ran: undefined = app.run("target");
    const reset: undefined = app.resetWarning();
    const warned: undefined = ports.warn();
    const status: number | null = ports.probe("target").status;
    const stdout: unknown = ports.probe("target").stdout;
    createContainerSocketAccess({ ...ports, probe: () => native, grant: () => native });
    createContainerSocketAccess({ ...ports, probe: () => ({ status: null }) });
    createContainerSocketAccess({ ...ports, probe: () => ({ status: 10, stdout: Symbol("opaque") }) });
    void [ran, reset, warned, status, stdout];

    // @ts-expect-error All ports are required.
    createContainerSocketAccess();
    // @ts-expect-error Undefined cannot supply ports.
    createContainerSocketAccess(undefined);
    // @ts-expect-error Probe is required.
    createContainerSocketAccess({ grant: ports.grant, warn: ports.warn });
    // @ts-expect-error Grant is required.
    createContainerSocketAccess({ probe: ports.probe, warn: ports.warn });
    // @ts-expect-error Warn is required.
    createContainerSocketAccess({ probe: ports.probe, grant: ports.grant });
    // @ts-expect-error Probe must be callable.
    createContainerSocketAccess({ ...ports, probe: {} });
    // @ts-expect-error Grant must be callable.
    createContainerSocketAccess({ ...ports, grant: false });
    // @ts-expect-error Warn must be callable.
    createContainerSocketAccess({ ...ports, warn: undefined });
    // @ts-expect-error Probe must be synchronous.
    createContainerSocketAccess({ ...ports, probe: async () => ({ status: 0 }) });
    // @ts-expect-error Grant must be synchronous.
    createContainerSocketAccess({ ...ports, grant: async () => ({ status: 0 }) });
    // @ts-expect-error Warn must be synchronous.
    createContainerSocketAccess({ ...ports, warn: async () => undefined });
    // @ts-expect-error Void does not prove synchronous completion.
    createContainerSocketAccess({ ...ports, warn: (): void => {} });
    // @ts-expect-error Warning effects cannot return values.
    createContainerSocketAccess({ ...ports, warn: () => true });
    // @ts-expect-error Probe status is required.
    createContainerSocketAccess({ ...ports, probe: () => ({ stdout: "ccc 0" }) });
    // @ts-expect-error Grant status is required.
    createContainerSocketAccess({ ...ports, grant: () => ({}) });
    // @ts-expect-error Probe status must be number or null.
    createContainerSocketAccess({ ...ports, probe: () => ({ status: "10" }) });
    // @ts-expect-error Grant status must be number or null.
    createContainerSocketAccess({ ...ports, grant: () => ({ status: undefined }) });
    // @ts-expect-error Run requires a target.
    app.run();
    // @ts-expect-error Run requires a string target.
    app.run(1);
    // @ts-expect-error Probe requires a string target.
    ports.probe(1);
    // @ts-expect-error Grant requires all three arguments.
    ports.grant("target", "ccc");
    // @ts-expect-error Grant user is a string.
    ports.grant("target", 1, "0");
    // @ts-expect-error Grant GID remains a string.
    ports.grant("target", "ccc", 0);
    // @ts-expect-error Reset takes no arguments.
    app.resetWarning("target");
    // @ts-expect-error Run returns synchronous undefined.
    const promise: Promise<undefined> = app.run("target");
    // @ts-expect-error Reset returns synchronous undefined.
    const resetPromise: Promise<undefined> = app.resetWarning();
    // @ts-expect-error Run does not return a success boolean.
    const success: boolean = app.run("target");
    void [promise, resetPromise, success];
}
void compileContracts;

describe("container socket access compile contracts", () => {
    it("returns undefined through its strict synchronous methods", () => {
        const app = createContainerSocketAccess({ probe: () => ({ status: 0 }), grant: () => ({ status: 0 }), warn: () => undefined });
        expect(app.run("target")).toBeUndefined();
        expect(app.resetWarning()).toBeUndefined();
    });
});
