import type { ContainerRuntimeReadinessPorts } from "../ports/container-runtime-readiness.js";

export function createContainerRuntimeReadiness(ports: ContainerRuntimeReadinessPorts) {
    for (const name of ["isRunning", "runtimeInfo", "reportError", "exitFailure"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container runtime readiness requires a callable ${name} port.`);
        }
    }

    function run(): undefined {
        if (!ports.isRunning()) {
            const info = ports.runtimeInfo();
            ports.reportError(() => `Error: ${info.runtime} is not running.`);
            if (info.runtime === "docker") {
                if (info.flavor === "docker-desktop") {
                    ports.reportError(() => "Please start Docker Desktop and try again.");
                } else {
                    ports.reportError(() => "Please start the docker service (e.g. `sudo systemctl start docker`) and try again.");
                }
            } else {
                if (info.flavor === "podman-machine") {
                    ports.reportError(() => "Please start the Podman machine (`podman machine start`) and try again.");
                } else if (info.flavor === "podman-rootless") {
                    ports.reportError(() => "Please start the rootless Podman service (`systemctl --user start podman.socket`) and try again.");
                } else {
                    ports.reportError(() => "Please start the Podman service (`sudo systemctl start podman.socket`) and try again.");
                }
            }
            ports.exitFailure();
        }
    }

    return { run };
}
