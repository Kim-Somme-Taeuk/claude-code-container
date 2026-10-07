export type SessionLockLiveness = "active" | "stale" | "unknown";

export type ProcessStartObservation =
    | { status: "found"; token: string }
    | { status: "present" }
    | { status: "missing" }
    | { status: "unknown" };

export interface SessionLockOwner {
    pid: number;
    startToken?: string;
}

export function sessionLockOwner(content: string): SessionLockOwner | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as { version?: unknown; pid?: unknown; startToken?: unknown };
            if (record.version !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
                || typeof record.startToken !== "string" || record.startToken.length === 0
                || record.startToken.length > 256) {
                return null;
            }
            return { pid: Number(record.pid), startToken: record.startToken };
        }
    } catch {
        // Legacy lock files contain only the decimal PID.
    }
    const legacy = content.trim();
    if (!/^[1-9]\d*$/.test(legacy)) return null;
    const pid = Number(legacy);
    return Number.isSafeInteger(pid) ? { pid } : null;
}

/**
 * The batch script's stdout, as observations. Exported because the script itself only runs on
 * Windows, so this is the only part of the batch a test on any other host can reach — the same
 * split `parseWindowsBrokerNetstatListenerForTest` already uses for netstat in this codebase.
 *
 * Anything unrecognised is simply absent from the map, which the caller reads as "ask the
 * single-pid probe" — the batch is never the authority on whether a lock may be deleted.
 */
export function parseProcessStartObservations(
    stdout: string,
    pids: readonly number[],
): Map<number, ProcessStartObservation> {
    const observations = new Map<number, ProcessStartObservation>();
    const wanted = new Set(pids);
    for (const line of stdout.split(/\r?\n/)) {
        const row = /^([0-9]+) (MISSING|UNKNOWN|FOUND:[0-9]+)$/.exec(line.trim());
        if (!row) continue;
        const pid = Number(row[1]);
        if (!wanted.has(pid) || observations.has(pid)) continue;
        if (row[2] === "MISSING") observations.set(pid, { status: "missing" });
        else if (row[2] === "UNKNOWN") observations.set(pid, { status: "unknown" });
        else observations.set(pid, { status: "found", token: `windows:${row[2].slice("FOUND:".length)}` });
    }
    return observations;
}
