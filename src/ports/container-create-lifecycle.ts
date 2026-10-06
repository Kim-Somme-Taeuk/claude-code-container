export interface ContainerCreateLifecycleRequest {
    containerName: string;
    projectMountIdentity: string;
    profile?: string;
    debug?: boolean;
}

export interface ContainerCreateResult {
    status: number | null;
    stdout: string | null | undefined;
}

export type CreatedContainerMountVerification =
    | { kind: "verified"; via: "shape" | "source" | "identity" | "daemon" }
    | { kind: "deferred"; reason: string; containerPath: string }
    | { kind: "retryable"; reason: string; containerPath?: string }
    | { kind: "mismatch"; reason: string; containerPath?: string };

export interface ContainerCreateLifecyclePorts {
    withFamilyLock(prefix: string, operation: () => string): string;
    namespaceExists(name: string): boolean;
    findCollision(): { containerName: string } | null;
    reportCreating(name: string, debug: boolean | undefined): undefined;
    reportLabWarning(): undefined;
    reportCreateFailure(): undefined;
    prepareRunArgs(): string[];
    assertProjectSources(): undefined;
    assertDeviceSources(): undefined;
    assertFilesystemSources(): undefined;
    create(args: string[]): ContainerCreateResult;
    verifyCreated(id: string): CreatedContainerMountVerification;
    removeRejected(id: string): undefined;
    explicitlyAbsent(id: string): boolean;
    syncMcp(id: string): undefined;
    fixSsh(id: string): undefined;
    syncGit(id: string): undefined;
    finish(id: string): string;
}
