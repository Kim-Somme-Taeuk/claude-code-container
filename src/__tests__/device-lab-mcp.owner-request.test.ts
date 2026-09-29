import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerRpc } from "../../device-lab-mcp/src/broker.mjs";
import { deviceLabProjectMountPath } from "../device-lab-owner.js";

describe("device-lab MCP canonical owner requests", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    const hostPath = "/host/projects/owner-request";
    const mountPath = deviceLabProjectMountPath(hostPath);

    it.each([
        [hostPath, ""],
        [mountPath, ""],
        [hostPath, "work"],
        [mountPath, "work"],
    ])("sends a canonical mount from %s with profile %s and preserves owner rejection", async (cwd, profile) => {
        vi.spyOn(process, "cwd").mockReturnValue(cwd);
        vi.stubEnv("CCC_PROFILE", profile);
        const fetchMock = vi.fn().mockResolvedValue(new Response(
            JSON.stringify({ ok: false, error: "project-owner-unavailable" }),
            { status: 404, headers: { "content-type": "application/json" } },
        ));
        vi.stubGlobal("fetch", fetchMock);

        const result = await brokerRpc({
            method: "broker.echo",
            hostCandidates: ["127.0.0.1"],
            port: 43123,
            autolaunch: false,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, request] = fetchMock.mock.calls[0];
        expect(url).toBe("http://127.0.0.1:43123/v1/owner/resolve");
        expect(request.method).toBe("POST");
        expect(JSON.parse(request.body)).toEqual({ projectMountPath: mountPath, profile: profile || null });
        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: "broker-owner-resolve-unavailable",
            attempts: [expect.objectContaining({
                status: 404,
                body: { ok: false, error: "project-owner-unavailable" },
            })],
        }));
    });
});
