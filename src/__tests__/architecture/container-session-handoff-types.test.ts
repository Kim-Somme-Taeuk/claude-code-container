import { describe, expect, it } from "vitest";
import { createContainerSessionHandoff } from "../../application/container-session-handoff.js";
import type { ContainerSessionHandoffPorts } from "../../ports/container-session-handoff.js";

// Keep compile-only rejection checks inside an uncalled function so this file
// also remains a runnable architecture test.
function compileContracts(ports: ContainerSessionHandoffPorts) {
    const app = createContainerSessionHandoff(ports);
    const result: string = app.run("id", "name");
    const project: undefined = ports.assertProjectSources();
    const filesystem: undefined = ports.assertFilesystemSources();
    app.run("id", "name", () => 1);
    app.run("id", "name", async () => "legacy-value");
    app.run("id", "name", (): void => {});
    void [result, project, filesystem];

    // @ts-expect-error All handoff capabilities are explicit and required.
    createContainerSessionHandoff();
    // @ts-expect-error Undefined cannot supply required ports.
    createContainerSessionHandoff(undefined);
    // @ts-expect-error Source assertions cannot be omitted.
    createContainerSessionHandoff({ identity: ports.identity });
    // @ts-expect-error Identity is required even when readiness is absent.
    createContainerSessionHandoff({ assertProjectSources: ports.assertProjectSources, assertFilesystemSources: ports.assertFilesystemSources });
    // @ts-expect-error Effects must be callable.
    createContainerSessionHandoff({ ...ports, assertProjectSources: true });
    // @ts-expect-error Project assertion must complete synchronously.
    createContainerSessionHandoff({ ...ports, assertProjectSources: async () => undefined });
    // @ts-expect-error Filesystem assertion must complete synchronously.
    createContainerSessionHandoff({ ...ports, assertFilesystemSources: async () => undefined });
    // @ts-expect-error Permissive void cannot prove synchronous project completion.
    createContainerSessionHandoff({ ...ports, assertProjectSources: (): void => {} });
    // @ts-expect-error Permissive void cannot prove synchronous filesystem completion.
    createContainerSessionHandoff({ ...ports, assertFilesystemSources: (): void => {} });
    // @ts-expect-error Assertion effects cannot return native facts.
    createContainerSessionHandoff({ ...ports, assertProjectSources: () => ({ status: 0 }) });
    // @ts-expect-error Identity observation must be synchronous.
    createContainerSessionHandoff({ ...ports, identity: async () => null });
    // @ts-expect-error Identity facts must include running state.
    createContainerSessionHandoff({ ...ports, identity: () => ({ containerId: "id" }) });
    // @ts-expect-error ID is required.
    app.run();
    // @ts-expect-error Public name is required.
    app.run("id");
    // @ts-expect-error Readiness must be callable when supplied.
    app.run("id", "name", true);
}
void compileContracts;

describe("session handoff compile contracts", () => {
    it("keeps the synchronous public string with legacy value and Promise callbacks", () => {
        const app = createContainerSessionHandoff({
            assertProjectSources: () => undefined,
            assertFilesystemSources: () => undefined,
            identity: id => ({ containerId: id, running: true }),
        });
        expect(app.run("id", "name", () => 1)).toBe("name");
        expect(app.run("id", "name", async () => "value")).toBe("name");
    });
});
