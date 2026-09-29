import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import * as identity from "../device-lab-process-identity.js";
import { discoverBrokerPortProcessForTest, hostBrokerRuntimeFromPortProcessForTest } from "../device-lab-broker.js";

vi.mock("child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("child_process")>(), spawnSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function output(stdout: string, overrides = {}) { return { status: 0, stdout, stderr: "", signal: null, ...overrides }; }

describe("Darwin broker listener process verification", () => {
    it("uses canonical lsof and unlimited-width ps with bounded calls", () => {
        const spawn = vi.mocked(childProcess.spawnSync);
        const commandLine = `/usr/local/bin/node /project/${"long-path-".repeat(35)}index.js devices broker serve --port 17373`;
        spawn.mockReturnValueOnce(output("p12345\n") as any).mockReturnValueOnce(output(commandLine + "\n") as any);
        const processIdentity = { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockReturnValue(processIdentity);
        const actual = discoverBrokerPortProcessForTest(17373, "darwin");
        expect(actual).toMatchObject({ pid: 12345, commandLine, processIdentity });
        expect(spawn.mock.calls).toEqual([
            ["/usr/sbin/lsof", ["-nP", "-iTCP:17373", "-sTCP:LISTEN", "-Fp"], expect.objectContaining({ timeout: 5000 })],
            ["/bin/ps", ["-ww", "-p", "12345", "-o", "command="], expect.objectContaining({ timeout: 5000 })],
        ]);
        expect(read).toHaveBeenCalledWith(12345, { platform: "darwin" });
    });
    it.each([{ status: 1 }, { error: new Error("timed out") }, { signal: "SIGTERM" }])("rejects failed ps even when partial stdout looks like a broker", (failure) => {
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset();
        spawn.mockReturnValueOnce(output("p12345\n") as any).mockReturnValueOnce(output("node index.js devices broker serve --port 17373", failure) as any);
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity");
        expect(discoverBrokerPortProcessForTest(17373, "darwin")).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });
    it.each(["", "not a pid\n", "p0\n"])("rejects unavailable or malformed listener identity: %j", (stdout) => {
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset();
        spawn.mockReturnValueOnce(output(stdout) as any);
        expect(discoverBrokerPortProcessForTest(17373, "darwin")).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it("does not relax the exact CLI path fence for whitespace-ambiguous ps output", () => {
        const processIdentity = { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        const commandLine = "/usr/local/bin/node /project/path with spaces/dist/index.js devices broker serve --port 17373";
        const actual = hostBrokerRuntimeFromPortProcessForTest("owner", 17373, {}, "darwin", () => ({ pid: 12345, commandLine, processIdentity }), null, null, "/project/path with spaces/dist/index.js");
        expect(actual).toBeNull();
    });
});
