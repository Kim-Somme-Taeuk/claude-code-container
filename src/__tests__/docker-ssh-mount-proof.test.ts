import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));
vi.mock("../container-runtime.js", async () => ({ ...await vi.importActual("../container-runtime.js"), runtimeCli: () => "docker" }));
import { readDirectoryMountMarker } from "../docker.js";
const marker = `/home/ccc/.ssh/.ccc-mount-identity-${"a".repeat(32)}`;
beforeEach(() => native.spawnSync.mockReset());
it("retries an unreadable SSH mount challenge as root without reading a key", () => {
    native.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0, stdout: "challenge" });
    expect(readDirectoryMountMarker("container-id", marker).stdout).toBe("challenge");
    expect(native.spawnSync.mock.calls[1][1]).toEqual(["exec", "--user", "root", "container-id", "cat", marker]);
});
it.each(["/home/ccc/.ssh/id_ed25519", "/other/.ccc-mount-identity-" + "a".repeat(32), "/home/ccc/.ssh/../secret"])("never elevates non-challenge path %s", path => {
    native.spawnSync.mockReturnValue({ status: 1 });
    expect(readDirectoryMountMarker("container-id", path).status).toBe(1);
    expect(native.spawnSync).toHaveBeenCalledTimes(1);
});
it("keeps a failed elevated challenge failed", () => {
    native.spawnSync.mockReturnValue({ status: 1 });
    expect(readDirectoryMountMarker("container-id", marker).status).toBe(1);
    expect(native.spawnSync).toHaveBeenCalledTimes(2);
});
