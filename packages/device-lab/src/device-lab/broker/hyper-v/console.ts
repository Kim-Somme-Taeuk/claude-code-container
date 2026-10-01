export type HyperVConsoleFrame = {
    readonly incarnationId: string;
    readonly width: number;
    readonly height: number;
    readonly nativeWidth: number;
    readonly nativeHeight: number;
    readonly capturedAt: string;
};

const frames = new Map<string, HyperVConsoleFrame>();
const operations = new Map<string, Promise<void>>();
const FRAME_MAX_AGE_MS = 2 * 60 * 1000;
const keyNames = new Set([
    "CTRL", "ALT", "SHIFT", "WIN", "ENTER", "TAB", "ESC", "SPACE", "BACKSPACE", "DELETE",
    "INSERT", "HOME", "END", "PAGEUP", "PAGEDOWN", "UP", "DOWN", "LEFT", "RIGHT",
]);
const modifiers = new Set(["CTRL", "ALT", "SHIFT", "WIN"]);

export function hyperVConsoleFrameKey(ownerId: string, backend: string, deviceId: string): string {
    return `${ownerId}:${backend}:${deviceId}`;
}

export function rememberHyperVConsoleFrame(key: string, frame: HyperVConsoleFrame): void {
    frames.set(key, frame);
}

export function currentHyperVConsoleFrame(key: string, incarnationId: string): HyperVConsoleFrame | null {
    const frame = frames.get(key);
    if (!frame || frame.incarnationId !== incarnationId) return null;
    const capturedAt = Date.parse(frame.capturedAt);
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > FRAME_MAX_AGE_MS || capturedAt > Date.now()) {
        frames.delete(key);
        return null;
    }
    return frame;
}

export function forgetHyperVConsoleFrame(key: string): void {
    frames.delete(key);
}

export async function withHyperVConsoleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    operations.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        if (operations.get(key) === current) operations.delete(key);
        release();
    }
}

export function hyperVConsolePixel(value: unknown, dimension: number): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < dimension
        ? value : null;
}

export function hyperVConsoleKeyTokens(value: unknown): string[] | null {
    if (typeof value !== "string" || value.length < 1 || value.length > 64) return null;
    const tokens = value.split("+").map((token) => token.trim().toUpperCase());
    if (tokens.length < 1 || tokens.length > 4 || tokens.some((token) => !token)) return null;
    const normalized = tokens.map((token) => token === "CONTROL" ? "CTRL" : token === "ESCAPE" ? "ESC" : token);
    const valid = (token: string) => keyNames.has(token) || /^[A-Z0-9]$/.test(token) || /^F(?:[1-9]|1[0-2])$/.test(token);
    if (normalized.some((token) => !valid(token))) return null;
    if (normalized.slice(0, -1).some((token) => !modifiers.has(token))) return null;
    if (modifiers.has(normalized.at(-1) || "")) return null;
    if (new Set(normalized).size !== normalized.length) return null;
    return normalized;
}

export function hyperVConsoleText(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= 2048 && !value.includes("\0")
        ? value : null;
}
