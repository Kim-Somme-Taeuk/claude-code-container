import type {
    ContainerCreateLifecyclePorts,
    ContainerCreateLifecycleRequest,
} from "../ports/container-create-lifecycle.js";

export function createContainerCreateLifecycle(ports: ContainerCreateLifecyclePorts) {
    for (const name of [
        "withFamilyLock", "namespaceExists", "findCollision", "reportCreating",
        "reportLabWarning", "reportCreateFailure", "prepareRunArgs",
        "assertProjectSources", "assertDeviceSources", "assertFilesystemSources",
        "create", "verifyCreated", "removeRejected", "explicitlyAbsent",
        "syncMcp", "fixSsh", "syncGit", "finish",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container create lifecycle requires a callable ${name} port.`);
        }
    }

    function run(request: ContainerCreateLifecycleRequest): string {
        const { containerName, projectMountIdentity, profile, debug } = request;
        return ports.withFamilyLock(`mount-${projectMountIdentity}`, () => {
            if (ports.namespaceExists(containerName)) {
                throw new Error(
                    `Container namespace ${containerName} appeared during creation preflight; refusing replacement.`,
                );
            }
            const collision = ports.findCollision();
            if (collision) {
                const profileName = profile ?? "default";
                throw new Error(
                    `CCC container ${collision.containerName} already owns this physical project `
                    + `for profile ${profileName}; refusing duplicate container creation. `
                    + "The existing container was preserved.",
                );
            }
            ports.reportCreating(containerName, debug);
            ports.reportLabWarning();
            const args = ports.prepareRunArgs();
            ports.assertProjectSources();
            ports.assertDeviceSources();
            ports.assertFilesystemSources();
            const result = ports.create(args);
            if (result.status !== 0) {
                ports.reportCreateFailure();
                throw new Error("Failed to create container");
            }
            const createdContainerId = (result.stdout ?? "").trim().split(/\s+/)
                .find((token) => /^[a-f0-9]{64}$/i.test(token)) ?? null;

            try {
                ports.assertProjectSources();
                ports.assertDeviceSources();
                ports.assertFilesystemSources();
                const verification = createdContainerId
                    ? ports.verifyCreated(createdContainerId)
                    : { kind: "mismatch", reason: "container runtime did not return an exact 64-hex container ID" } as const;
                if (verification.kind !== "verified") {
                    throw new Error(
                        `created container bind mount identity verification failed (${verification.reason})`,
                    );
                }
            } catch (error) {
                if (createdContainerId) {
                    ports.removeRejected(createdContainerId);
                    if (!ports.explicitlyAbsent(createdContainerId)) {
                        throw new Error(
                            `${(error as Error).message}; failed to remove rejected container ${createdContainerId}`,
                            { cause: error },
                        );
                    }
                }
                throw error;
            }

            if (!createdContainerId) {
                throw new Error("Container runtime did not return the created container ID; refusing an unpinned session.");
            }
            ports.syncMcp(createdContainerId);
            ports.fixSsh(createdContainerId);
            ports.syncGit(createdContainerId);
            return ports.finish(createdContainerId);
        });
    }

    return { run };
}
