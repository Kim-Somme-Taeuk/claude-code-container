export interface ContainerExecReadinessPorts {
    now(): number;
    canExec(target: string, timeoutMs: number): boolean;
    sleep(ms: number): undefined;
}
