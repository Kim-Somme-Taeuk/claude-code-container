export interface ContainerSocketAccessPorts {
    probe(target: string): { status: number | null; stdout?: unknown };
    grant(target: string, user: string, gid: string): { status: number | null };
    warn(): undefined;
}
