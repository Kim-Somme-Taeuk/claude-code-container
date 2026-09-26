import { describe, expect, it, vi } from "vitest";

import { createHyperVGuestDirectClient, type HyperVWindowsExecutionRequest } from "../hyper-v-windows/index.js";
import { invokeDeviceLabHyperVGuestDirect } from "../device-lab/broker/hyper-v/guest-direct-adapter.js";

const identity = {
    selector: { kind: "id" as const, id: "12345678-1234-1234-1234-123456789abc" },
    expectedName: "owned-vm",
    expectedNotes: "owner-marker",
    credentialPath: "C:\\private\\guest.credential.xml",
};

function success(request: HyperVWindowsExecutionRequest, items: unknown[]) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
}

describe("typed Hyper-V PowerShell Direct", () => {
    it("rejects malformed identity, command, paths, limits and extra fields before execution", async () => {
        const execute = vi.fn(() => success({ schemaVersion: 1, operation: "Invoke-Guest", ...identity, action: "mkdir", remotePath: "C:\\x" }, []));
        const client = createHyperVGuestDirectClient({ execute });
        const valid = { ...identity, action: "exec" as const, command: "whoami" };
        await expect(client.invoke({ ...valid, selector: { kind: "id", id: "wrong" } }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, credentialPath: "relative.xml" }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, command: "\0" }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...identity, action: "download", localPath: "C:\\stage", remotePath: "C:\\file", maxBytes: 16 * 1024 * 1024 + 1 }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, extra: true } as typeof valid, 1000)).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });

    it("accepts guest nonzero exit as a completed typed result and rejects malformed replies", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "exec", status: 7, stdout: "", stderr: "failed" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "exec", command: "exit 7" }, 1000)).resolves.toEqual({ action: "exec", status: 7, stdout: "", stderr: "failed" });
        execute.mockImplementation((request) => success(request, [{ action: "exec", status: 0, stdout: "", stderr: "", leaked: true }]));
        await expect(client.invoke({ ...identity, action: "exec", command: "whoami" }, 1000)).rejects.toMatchObject({ category: "protocol" });
    });

    it("accepts literal Windows bracket characters in an owner-private credential path", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "exec", status: 0, stdout: "ok", stderr: "" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, credentialPath: "C:\\Users\\Alice [Org]\\guest.xml", action: "exec", command: "whoami" }, 1000)).resolves.toMatchObject({ status: 0 });
    });

    it("does not replay an invocation after a lost response", async () => {
        const execute = vi.fn(() => ({ status: null, stdout: "", error: "connection-lost" }));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "exec", command: "whoami" }, 1000)).rejects.toMatchObject({ category: "transport" });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("decodes a bounded PowerShell Direct job probe and rejects extra fields", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "job", output: "{\"ready\":false}" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "job", command: "Write-Output '{}'" }, 20000)).resolves.toEqual({ action: "job", output: "{\"ready\":false}" });
        execute.mockImplementation((request) => success(request, [{ action: "job", output: "{}", extra: true }]));
        await expect(client.invoke({ ...identity, action: "job", command: "Write-Output '{}'" }, 20000)).rejects.toMatchObject({ category: "protocol" });
    });

    it("orders remote directory creation before upload and uses one-shot requests", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
            const request = JSON.parse(envelope.input) as HyperVWindowsExecutionRequest;
            requests.push(request);
            return success(request, [request.operation === "Invoke-Guest" && request.action === "mkdir"
                ? { action: "mkdir" }
                : { action: "upload", localPath: "C:\\stage\\upload.tmp", remotePath: "C:\\target\\file.txt", bytes: 6 }]);
        });
        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe",
            timeoutMilliseconds: 30000,
            run,
            identity,
            action: { action: "upload", localPath: "C:\\stage\\upload.tmp", remotePath: "C:\\target\\file.txt" },
        })).resolves.toMatchObject({ action: "upload", bytes: 6 });
        expect(requests.map((request) => request.operation === "Invoke-Guest" ? request.action : "wrong")).toEqual(["mkdir", "upload"]);
    });
});
