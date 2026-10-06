export interface CodexConfigPreparationPorts {
    probe(target: string): { status: number | null; error?: unknown };
    repair(target: string): { status: number | null; error?: unknown };
    finalize(target: string): { status: number | null; error?: unknown };
}
