export interface ContainerImagePreparationRequest {
    imageName: string;
    version: string;
    registryImage: string;
}

export interface ContainerImagePreparationPorts {
    exists(): boolean;
    label(imageName: string, key: string): string | null;
    qualify(ref: string): string;
    pull(ref: string): boolean;
    tag(source: string, target: string): undefined;
    reportStale(label: string, version: string): undefined;
    reportPull(version: string): undefined;
    reportFallback(ref: string): undefined;
    reportFailure(ref: string): undefined;
    reportBuildHint(): undefined;
    exitFailure(): undefined;
}
