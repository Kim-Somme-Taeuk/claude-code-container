export interface SessionCleanupPorts {
    projectId(path: string): string;
    withLifecycleLock<T>(prefix: string, operation: () => T): T;
    hasOtherClaims(prefix: string, ownPath: string): boolean;
    removeClaim(path: string): undefined;
    cleanupDevices(path: string, timeoutMs: number, profile?: string): undefined;
    reportDeviceCleanupFailure(error: unknown): undefined;
    stopContainer(readContainerId: () => string | null): undefined;
}
