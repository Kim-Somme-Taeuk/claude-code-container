export type NestedProgressSink = (message: string) => void;

/** Reports waiting, not guest liveness: a pending RPC or old progress file proves neither. */
export function nestedProgress(sink?: NestedProgressSink) {
    const started = Date.now();
    let stage = "";
    let changed = started;
    const emit = (waiting: boolean) => sink?.(`[ccc] nested: ${stage}${waiting ? " (waiting)" : ""}; elapsed ${Math.floor((Date.now() - started) / 1000)}s; stage ${Math.floor((Date.now() - changed) / 1000)}s`);
    const timer = sink ? setInterval(() => emit(true), 30000) : undefined;
    timer?.unref();
    return {
        stage(value: string) {
            if (stage === value) return;
            stage = value;
            changed = Date.now();
            emit(false);
        },
        close() { if (timer) clearInterval(timer); },
    };
}

export function nestedGuestProgress(value: unknown, runId: string): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.kind !== "progress" || record.runId !== runId) return undefined;
    return typeof record.stage === "string" && ["bootstrap", "install", "build", "test", "cleanup"].includes(record.stage)
        ? record.stage : undefined;
}
