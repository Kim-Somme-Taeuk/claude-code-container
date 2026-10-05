import type { HyperVWindowsOperation } from "./contracts.js";

export type HyperVWindowsErrorCategory = "validation" | "transport" | "protocol" | "native";

export type HyperVWindowsNativeDiagnostics = {
    readonly nativeHResult?: number;
    readonly nativeErrorCategory?: number;
};

// Optional on legacy envelopes; present values must be numeric, never host text.
export function parseHyperVWindowsNativeDiagnostics(value: Record<string, unknown>): HyperVWindowsNativeDiagnostics | null {
    const result: { nativeHResult?: number; nativeErrorCategory?: number } = {};
    for (const [key, minimum, maximum] of [
        ["nativeHResult", -2147483648, 2147483647],
        ["nativeErrorCategory", 0, 31],
    ] as const) {
        if (!Object.hasOwn(value, key)) continue;
        const candidate = value[key];
        if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < minimum || candidate > maximum) return null;
        result[key] = candidate;
    }
    return result;
}

type HyperVWindowsErrorOptions = HyperVWindowsNativeDiagnostics & {
    readonly category: HyperVWindowsErrorCategory;
    readonly operation: HyperVWindowsOperation;
    readonly code: string;
    readonly nativeStatus?: number;
};

export class HyperVWindowsError extends Error {
    readonly category: HyperVWindowsErrorCategory;
    readonly operation: HyperVWindowsOperation;
    readonly code: string;
    readonly nativeStatus?: number;

    readonly nativeHResult?: number;
    readonly nativeErrorCategory?: number;

    constructor(options: HyperVWindowsErrorOptions) {
        super(`hyper-v-windows-${options.category}:${options.operation}:${options.code}`);
        this.name = "HyperVWindowsError";
        this.category = options.category;
        this.operation = options.operation;
        this.code = options.code;
        if (options.nativeHResult !== undefined) this.nativeHResult = options.nativeHResult;
        if (options.nativeErrorCategory !== undefined) this.nativeErrorCategory = options.nativeErrorCategory;
        if (options.nativeStatus !== undefined) this.nativeStatus = options.nativeStatus;
    }
}
