import type { ContainerSessionHandoffPorts } from "../ports/container-session-handoff.js";

export function createContainerSessionHandoff(ports: ContainerSessionHandoffPorts) {
    for (const name of ["assertProjectSources", "assertFilesystemSources", "identity"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container session handoff requires a callable ${name} port.`);
        }
    }

    function run(containerId: string, containerName: string, onReady?: (id: string) => void): string {
        ports.assertProjectSources();
        ports.assertFilesystemSources();
        if (onReady) {
            const finalIdentity = ports.identity(containerId);
            if (!finalIdentity?.running || finalIdentity.containerId !== containerId) {
                throw new Error("Container identity changed before session handoff; refusing to join.");
            }
            onReady(containerId);
        }
        return containerName;
    }

    return { run };
}
