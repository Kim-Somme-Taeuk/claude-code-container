import { createContainerImagePreparation } from "../../application/container-image-preparation.js";
import type {
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
} from "../../ports/container-image-preparation.js";

declare const ports: ContainerImagePreparationPorts;
const app = createContainerImagePreparation(ports);
const request: ContainerImagePreparationRequest = { imageName: "ccc", version: "1.2.3", registryImage: "team/image" };
const result: undefined = app.run(request);
const present: boolean = ports.exists();
const label: string | null = ports.label("ccc", "cli.version");
const qualified: string = ports.qualify("team/image:1.2.3");
const pulled: boolean = ports.pull(qualified);
const tagged: undefined = ports.tag(qualified, "ccc");
const exited: undefined = ports.exitFailure();
void [result, present, label, qualified, pulled, tagged, exited];

type Assert<T extends true> = T;
type EveryPortRequired = Assert<{
    [K in keyof ContainerImagePreparationPorts]: {} extends Pick<ContainerImagePreparationPorts, K> ? false : true
}[keyof ContainerImagePreparationPorts] extends true ? true : false>;
type AsyncPort<T extends (...args: never[]) => unknown> = (...args: Parameters<T>) => Promise<ReturnType<T>>;
type EveryPortSynchronous = Assert<{
    [K in keyof ContainerImagePreparationPorts]:
        AsyncPort<ContainerImagePreparationPorts[K]> extends ContainerImagePreparationPorts[K] ? false : true
}[keyof ContainerImagePreparationPorts] extends true ? true : false>;
const required: EveryPortRequired = true;
const synchronous: EveryPortSynchronous = true;
void [required, synchronous];

// @ts-expect-error The operation has no ambient capabilities.
createContainerImagePreparation();
// @ts-expect-error Required ports cannot be absent.
createContainerImagePreparation(undefined);
// @ts-expect-error Every capability is required.
createContainerImagePreparation({ exists: ports.exists });
// @ts-expect-error Ports must be callable.
createContainerImagePreparation({ ...ports, reportPull: true });
// @ts-expect-error Existence remains synchronous and boolean.
createContainerImagePreparation({ ...ports, exists: async () => true });
// @ts-expect-error Inspection remains synchronous and nullable.
createContainerImagePreparation({ ...ports, label: async () => null });
// @ts-expect-error Qualification returns a synchronous reference.
createContainerImagePreparation({ ...ports, qualify: async ref => ref });
// @ts-expect-error Pull returns a synchronous boolean.
createContainerImagePreparation({ ...ports, pull: async () => true });
// @ts-expect-error Synchronous effects cannot return promises.
createContainerImagePreparation({ ...ports, tag: async () => undefined });
// @ts-expect-error Permissive void does not prove synchronous completion.
createContainerImagePreparation({ ...ports, reportBuildHint: (): void => {} });
// @ts-expect-error Native results cannot escape through effect ports.
createContainerImagePreparation({ ...ports, tag: () => ({ status: 0 }) });
// @ts-expect-error Exit interception may return, but must remain synchronous.
createContainerImagePreparation({ ...ports, exitFailure: async () => undefined });
// @ts-expect-error Existence does not expose native status codes.
createContainerImagePreparation({ ...ports, exists: () => 0 });
// @ts-expect-error Label observations use null, not absent undefined.
createContainerImagePreparation({ ...ports, label: () => undefined });
// @ts-expect-error Every request fact is required.
app.run({ imageName: "ccc", version: "1.2.3" });
// @ts-expect-error Version remains a string.
app.run({ ...request, version: 123 });
