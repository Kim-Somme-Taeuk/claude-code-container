export interface AndroidAvdIdentityCommandResult {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: unknown;
}

export function readAndroidAvdIdentity(
    serial: string,
    runAdb: (args: string[]) => AndroidAvdIdentityCommandResult,
): { ok: true; name: string } | { ok: false; detail: string };
