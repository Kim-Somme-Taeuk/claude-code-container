import { parseRuntimeOverride, type RuntimeName } from "../../domain/container-runtime.js";
import { createContainerRuntimeSelector } from "../../application/container-runtime-selection.js";
import type { ContainerRuntimeSelectionPorts } from "../../ports/container-runtime-selection.js";

const explicit: RuntimeName | null = parseRuntimeOverride("podman", "cli");
const environment: RuntimeName | null = parseRuntimeOverride(undefined, "environment");
const valid: ContainerRuntimeSelectionPorts = {
    getExplicitOverride: () => explicit,
    getEnvironmentOverride: () => environment ?? undefined,
    isRuntimeAvailable: runtime => runtime === "docker",
};
const select: () => RuntimeName = createContainerRuntimeSelector(valid);
const selected: RuntimeName = select();
void selected;

// @ts-expect-error All three selection ports are required.
createContainerRuntimeSelector({ getExplicitOverride: () => null, getEnvironmentOverride: () => undefined });
// @ts-expect-error The factory requires explicit ports, without production defaults.
createContainerRuntimeSelector();
// @ts-expect-error Explicit override observation must be synchronous.
createContainerRuntimeSelector({ ...valid, getExplicitOverride: async () => "docker" as const });
// @ts-expect-error Environment observation must be synchronous.
createContainerRuntimeSelector({ ...valid, getEnvironmentOverride: async () => "docker" });
// @ts-expect-error Availability observation must be synchronous.
createContainerRuntimeSelector({ ...valid, isRuntimeAvailable: async () => true });
// @ts-expect-error Availability uses boolean results, not numeric statuses.
createContainerRuntimeSelector({ ...valid, isRuntimeAvailable: () => 0 });
// @ts-expect-error Explicit runtime names form a closed union.
createContainerRuntimeSelector({ ...valid, getExplicitOverride: () => "lxc" });
// @ts-expect-error Availability accepts only supported runtime names.
valid.isRuntimeAvailable("lxc");
// @ts-expect-error Validation source labels form a closed union.
parseRuntimeOverride("docker", "config");
// @ts-expect-error Validation receives strings or absent values, never numeric input.
parseRuntimeOverride(1, "cli");
// @ts-expect-error Validation can return no override.
const guaranteed: RuntimeName = parseRuntimeOverride(null, "cli");
void guaranteed;
