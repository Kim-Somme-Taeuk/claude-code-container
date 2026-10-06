import { parseRuntimeOverride, type RuntimeName } from "../domain/container-runtime.js";
import type { ContainerRuntimeSelectionPorts } from "../ports/container-runtime-selection.js";

export function createContainerRuntimeSelector(
    ports: ContainerRuntimeSelectionPorts,
): () => RuntimeName {
    for (const name of [
        "getExplicitOverride",
        "getEnvironmentOverride",
        "isRuntimeAvailable",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container runtime selection requires a callable ${name} port.`);
        }
    }

    return () => {
        const explicitOverride = ports.getExplicitOverride();
        if (explicitOverride) return explicitOverride;

        const environmentOverride = parseRuntimeOverride(
            ports.getEnvironmentOverride(),
            "environment",
        );
        if (environmentOverride) return environmentOverride;

        if (ports.isRuntimeAvailable("podman")) return "podman";
        if (ports.isRuntimeAvailable("docker")) return "docker";

        throw new Error(
            "No container runtime found. Install podman or docker and ensure the CLI is on PATH.",
        );
    };
}
