import { isAbsolute, win32 } from "path";

import { execute } from "./client.js";
import type {
    HyperVGuestDirectRequest,
    HyperVGuestDirectResult,
    HyperVWindowsExecutor,
} from "./contracts.js";
import { HyperVWindowsError } from "./errors.js";

const OPERATION = "Invoke-Guest";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

function fail(category: "validation" | "protocol", code: string): never {
    throw new HyperVWindowsError({ category, operation: OPERATION, code });
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

function hostPath(value: unknown): value is string {
    return text(value, 4096) && (isAbsolute(value) || win32.isAbsolute(value)) && !/[?*]/.test(value);
}

function guestPath(value: unknown): value is string {
    return text(value, 4096) && /^[A-Za-z]:\\/.test(value);
}

function validate(input: HyperVGuestDirectRequest): HyperVGuestDirectRequest {
    const request = record(input);
    if (!request) fail("validation", "guest-request-invalid");
    const keys = ["selector", "expectedName", "expectedNotes", "credentialPath", "action"];
    const extras = input.action === "exec" || input.action === "job" ? ["command"]
        : input.action === "mkdir" ? ["remotePath"]
            : input.action === "upload" ? ["localPath", "remotePath"]
                : input.action === "download" ? ["localPath", "remotePath", "maxBytes"] : [];
    if (extras.length === 0 || !exact(request, [...keys, ...extras])) fail("validation", "guest-request-invalid");
    const selector = record(input.selector);
    if (!selector || !exact(selector, ["kind", "id"]) || selector.kind !== "id"
        || typeof selector.id !== "string" || !GUID.test(selector.id)) fail("validation", "selector-id-invalid");
    if (!text(input.expectedName, 100) || !text(input.expectedNotes, 4096)
        || !hostPath(input.credentialPath)) fail("validation", "guest-identity-invalid");
    if (input.action === "exec" || input.action === "job") {
        if (typeof input.command !== "string" || input.command.length < 1
            || input.command.length > 4096 || input.command.includes("\0")) fail("validation", "guest-command-invalid");
    } else if (input.action === "mkdir") {
        if (!guestPath(input.remotePath)) fail("validation", "guest-path-invalid");
    } else {
        if (!hostPath(input.localPath) || !guestPath(input.remotePath)) fail("validation", "guest-path-invalid");
        if (input.action === "download" && (!Number.isSafeInteger(input.maxBytes)
            || input.maxBytes < 1 || input.maxBytes > MAX_DOWNLOAD_BYTES)) fail("validation", "guest-download-limit-invalid");
    }
    return { ...input, selector: { kind: "id", id: input.selector.id.toLowerCase() } };
}

function decode(input: HyperVGuestDirectRequest, items: unknown[]): HyperVGuestDirectResult {
    if (items.length !== 1) fail("protocol", "guest-result-ambiguous");
    const item = record(items[0]);
    if (!item || item.action !== input.action) fail("protocol", "guest-result-invalid");
    if (input.action === "exec") {
        if (!exact(item, ["action", "status", "stdout", "stderr"])
            || typeof item.status !== "number" || !Number.isInteger(item.status)
            || item.status < -2147483648 || item.status > 2147483647
            || typeof item.stdout !== "string" || item.stdout.length > 16384
            || typeof item.stderr !== "string" || item.stderr.length > 16384) fail("protocol", "guest-result-invalid");
        return item as HyperVGuestDirectResult;
    }
    if (input.action === "job") {
        if (!exact(item, ["action", "output"]) || typeof item.output !== "string"
            || item.output.length < 1 || item.output.length > 16384) fail("protocol", "guest-result-invalid");
        return { action: "job", output: item.output };
    }
    if (input.action === "mkdir") {
        if (!exact(item, ["action"])) fail("protocol", "guest-result-invalid");
        return { action: "mkdir" };
    }
    if (!exact(item, ["action", "localPath", "remotePath", "bytes"])
        || item.localPath !== input.localPath || item.remotePath !== input.remotePath
        || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || (input.action === "download" && item.bytes > input.maxBytes)) fail("protocol", "guest-result-invalid");
    return item as HyperVGuestDirectResult;
}

export function createHyperVGuestDirectClient(executor: HyperVWindowsExecutor) {
    return {
        async invoke(input: HyperVGuestDirectRequest, timeoutMilliseconds: number): Promise<HyperVGuestDirectResult> {
            if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300000) {
                fail("validation", "guest-timeout-invalid");
            }
            const request = validate(input);
            const envelope = await execute(executor, { schemaVersion: 1, operation: OPERATION, ...request }, undefined, timeoutMilliseconds);
            return decode(request, envelope.items);
        },
    };
}
