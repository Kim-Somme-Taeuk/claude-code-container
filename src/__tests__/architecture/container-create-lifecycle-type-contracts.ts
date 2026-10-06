import { createContainerCreateLifecycle } from "../../application/container-create-lifecycle.js";
import type {
    ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest,
    ContainerCreateResult,
    CreatedContainerMountVerification,
} from "../../ports/container-create-lifecycle.js";

declare const ports: ContainerCreateLifecyclePorts;
const app = createContainerCreateLifecycle(ports);
const request: ContainerCreateLifecycleRequest = { containerName: "name", projectMountIdentity: "identity" };
const result: string = app.run(request);
const locked: string = ports.withFamilyLock("prefix", () => "name");
const effect: undefined = ports.syncMcp("id");
const nativeFacts: ContainerCreateResult = { status: null, stdout: undefined };
const variants: CreatedContainerMountVerification[] = [
    { kind: "verified", via: "shape" }, { kind: "verified", via: "source" },
    { kind: "verified", via: "identity" }, { kind: "verified", via: "daemon" },
    { kind: "deferred", reason: "missing", containerPath: "/project" },
    { kind: "retryable", reason: "pending" },
    { kind: "retryable", reason: "pending", containerPath: "/project" },
    { kind: "mismatch", reason: "wrong" },
    { kind: "mismatch", reason: "wrong", containerPath: "/project" },
];
for (const proof of variants) {
    if (proof.kind === "verified") {
        const via: "shape" | "source" | "identity" | "daemon" = proof.via;
        void via;
    } else {
        const reason: string = proof.reason;
        const path: string | undefined = proof.containerPath;
        void [reason, path];
    }
}
void [result, locked, effect, nativeFacts];

type Assert<T extends true> = T;
type EveryPortRequired = Assert<{
    [K in keyof ContainerCreateLifecyclePorts]: {} extends Pick<ContainerCreateLifecyclePorts, K> ? false : true
}[keyof ContainerCreateLifecyclePorts] extends true ? true : false>;
type AsyncPort<T extends (...args: never[]) => unknown> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type EveryPortSynchronous = Assert<{
    [K in keyof ContainerCreateLifecyclePorts]:
        AsyncPort<ContainerCreateLifecyclePorts[K]> extends ContainerCreateLifecyclePorts[K] ? false : true
}[keyof ContainerCreateLifecyclePorts] extends true ? true : false>;
const required: EveryPortRequired = true;
const synchronous: EveryPortSynchronous = true;
void [required, synchronous];

// @ts-expect-error Creation never supplies ambient capabilities.
createContainerCreateLifecycle();
// @ts-expect-error Required capabilities cannot be absent.
createContainerCreateLifecycle(undefined);
// @ts-expect-error All capabilities are required.
createContainerCreateLifecycle({ create: ports.create });
// @ts-expect-error Effects must be callable.
createContainerCreateLifecycle({ ...ports, reportLabWarning: true });
// @ts-expect-error Async observations cannot authorize synchronous creation.
createContainerCreateLifecycle({ ...ports, namespaceExists: async () => false });
// @ts-expect-error Effects must prove synchronous undefined completion.
createContainerCreateLifecycle({ ...ports, syncMcp: async () => undefined });
// @ts-expect-error Permissive void cannot prove synchronous completion.
createContainerCreateLifecycle({ ...ports, assertProjectSources: (): void => {} });
// @ts-expect-error Native result objects cannot leak through effect ports.
createContainerCreateLifecycle({ ...ports, removeRejected: () => ({ status: 0 }) });
// @ts-expect-error Create facts must include status and stdout.
createContainerCreateLifecycle({ ...ports, create: () => ({ status: 0 }) });
// @ts-expect-error Async creation cannot satisfy synchronous native facts.
createContainerCreateLifecycle({ ...ports, create: async () => ({ status: 0, stdout: "id" }) });
// @ts-expect-error Critical-section callbacks return strings synchronously.
ports.withFamilyLock("prefix", async () => "name");
// @ts-expect-error Critical-section callbacks cannot return void.
ports.withFamilyLock("prefix", (): void => {});
// @ts-expect-error Finishing retains the synchronous public string.
createContainerCreateLifecycle({ ...ports, finish: async () => "name" });
// @ts-expect-error Request must carry the physical family identity.
app.run({ containerName: "name" });
// @ts-expect-error Debug remains boolean rather than a truthy string.
app.run({ ...request, debug: "true" });
// @ts-expect-error Verified facts require the proof route.
const invalidVerified: CreatedContainerMountVerification = { kind: "verified" };
// @ts-expect-error Deferred facts require a container path.
const invalidDeferred: CreatedContainerMountVerification = { kind: "deferred", reason: "pending" };
// @ts-expect-error Creation results do not expose native errors to the application.
const invalidNativeFacts: ContainerCreateResult = { status: 0, stdout: "id", error: new Error("native") };
void [invalidVerified, invalidDeferred, invalidNativeFacts];
