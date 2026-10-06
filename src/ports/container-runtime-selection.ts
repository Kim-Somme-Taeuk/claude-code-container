import type { RuntimeName } from "../domain/container-runtime.js";

export interface ContainerRuntimeSelectionPorts {
    getExplicitOverride(): RuntimeName | null;
    getEnvironmentOverride(): string | undefined;
    isRuntimeAvailable(runtime: RuntimeName): boolean;
}
