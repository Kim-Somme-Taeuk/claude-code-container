import type {
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
} from "../ports/container-image-preparation.js";

export function createContainerImagePreparation(ports: ContainerImagePreparationPorts) {
    for (const name of [
        "exists", "label", "qualify", "pull", "tag", "reportStale", "reportPull",
        "reportFallback", "reportFailure", "reportBuildHint", "exitFailure",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container image preparation requires a callable ${name} port.`);
        }
    }

    function run(request: ContainerImagePreparationRequest): undefined {
        const localExists = ports.exists();
        if (localExists) {
            const label = ports.label(request.imageName, "cli.version");
            if (label === null) return;
            if (label === request.version) return;
            ports.reportStale(label, request.version);
        } else {
            ports.reportPull(request.version);
        }

        const remoteRef = ports.qualify(`${request.registryImage}:${request.version}`);
        if (ports.pull(remoteRef)) {
            ports.tag(remoteRef, request.imageName);
            return;
        }
        if (localExists) {
            ports.reportFallback(remoteRef);
            return;
        }
        ports.reportFailure(remoteRef);
        ports.reportBuildHint();
        ports.exitFailure();
    }

    return { run };
}
