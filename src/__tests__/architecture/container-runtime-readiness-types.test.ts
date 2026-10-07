import { describe, expect, it } from "vitest";
import { createContainerRuntimeReadiness } from "../../application/container-runtime-readiness.js";
import type { RuntimeInfo } from "../../container-runtime.js";
import { ensureDockerRunning } from "../../docker.js";
import type { ContainerRuntimeReadinessPorts } from "../../ports/container-runtime-readiness.js";

// Compile-only checks stay uncalled so rejected capabilities never execute.
function compileContracts(ports: ContainerRuntimeReadinessPorts, nativeInfo: RuntimeInfo) {
    const app = createContainerRuntimeReadiness(ports);
    const result: undefined = app.run();
    const report: undefined = ports.reportError(() => "message");
    const exit: undefined = ports.exitFailure();
    const publicResult: void = ensureDockerRunning();
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => nativeInfo });
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "docker", flavor: "future-flavor" }) });
    void [result, report, exit, publicResult];

    // @ts-expect-error Reporting requires a lazy message, not an eager string.
    ports.reportError("message");
    // @ts-expect-error Message rendering must return a synchronous string.
    ports.reportError(async () => "message");
    // @ts-expect-error Message rendering cannot return permissive void.
    ports.reportError((): void => {});
    // @ts-expect-error An eager-string reporter cannot satisfy the supplier contract.
    createContainerRuntimeReadiness({ ...ports, reportError: (_message: string): undefined => undefined });

    // @ts-expect-error All readiness capabilities are required.
    createContainerRuntimeReadiness();
    // @ts-expect-error Undefined cannot supply the required ports.
    createContainerRuntimeReadiness(undefined);
    // @ts-expect-error The running observation cannot be omitted.
    createContainerRuntimeReadiness({ runtimeInfo: ports.runtimeInfo, reportError: ports.reportError, exitFailure: ports.exitFailure });
    // @ts-expect-error Runtime facts cannot be omitted.
    createContainerRuntimeReadiness({ isRunning: ports.isRunning, reportError: ports.reportError, exitFailure: ports.exitFailure });
    // @ts-expect-error Error reporting cannot be omitted.
    createContainerRuntimeReadiness({ isRunning: ports.isRunning, runtimeInfo: ports.runtimeInfo, exitFailure: ports.exitFailure });
    // @ts-expect-error Failure exit cannot be omitted.
    createContainerRuntimeReadiness({ isRunning: ports.isRunning, runtimeInfo: ports.runtimeInfo, reportError: ports.reportError });
    // @ts-expect-error The running observation must be callable.
    createContainerRuntimeReadiness({ ...ports, isRunning: true });
    // @ts-expect-error Runtime facts must be callable.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: nativeInfo });
    // @ts-expect-error Error reporting must be callable.
    createContainerRuntimeReadiness({ ...ports, reportError: "message" });
    // @ts-expect-error Failure exit must be callable.
    createContainerRuntimeReadiness({ ...ports, exitFailure: 1 });
    // @ts-expect-error The running observation must return a synchronous boolean.
    createContainerRuntimeReadiness({ ...ports, isRunning: async () => true });
    // @ts-expect-error Runtime facts must be observed synchronously.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: async () => nativeInfo });
    // @ts-expect-error Error reporting must complete synchronously.
    createContainerRuntimeReadiness({ ...ports, reportError: async () => undefined });
    // @ts-expect-error Failure exit must complete synchronously.
    createContainerRuntimeReadiness({ ...ports, exitFailure: async () => undefined });
    // @ts-expect-error Permissive void does not prove synchronous error reporting.
    createContainerRuntimeReadiness({ ...ports, reportError: (): void => {} });
    // @ts-expect-error Permissive void does not prove synchronous failure exit.
    createContainerRuntimeReadiness({ ...ports, exitFailure: (): void => {} });
    // @ts-expect-error The running observation must return a boolean.
    createContainerRuntimeReadiness({ ...ports, isRunning: () => "running" });
    // @ts-expect-error Runtime facts must include their flavor.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "docker" }) });
    // @ts-expect-error Runtime names come from the pure RuntimeName contract.
    createContainerRuntimeReadiness({ ...ports, runtimeInfo: () => ({ runtime: "containerd", flavor: "unknown" }) });
    // @ts-expect-error Error reporting cannot return an effect result.
    createContainerRuntimeReadiness({ ...ports, reportError: () => true });
    // @ts-expect-error Failure exit cannot return an effect result.
    createContainerRuntimeReadiness({ ...ports, exitFailure: () => 1 });
    // @ts-expect-error The public facade keeps its legacy void signature.
    const strictPublicResult: undefined = ensureDockerRunning();
    void strictPublicResult;
}
void compileContracts;

describe("container runtime readiness compile contracts", () => {
    it("returns undefined through the strict synchronous application API", () => {
        const app = createContainerRuntimeReadiness({
            isRunning: () => true,
            runtimeInfo: () => ({ runtime: "docker", flavor: "unknown" }),
            reportError: () => undefined,
            exitFailure: () => undefined,
        });
        expect(app.run()).toBeUndefined();
    });
});
