import { spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
}));

const fixture = createDeviceLabAdminTestFixture();
afterEach(() => { fixture.cleanup(); vi.restoreAllMocks(); });

it("discovers only registered Node providers through Windows and POSIX lookup and preserves argument boundaries", () => {
    fixture.setupFixture("/project/admin-node-fixture");
    const bin = join(fixture.homeDir, "bin with spaces");
    mkdirSync(bin);
    const executable = fixture.writeNodeTool(bin, "adb", "process.stdout.write(JSON.stringify(args)); process.stderr.write('provider failed'); process.exit(7);");
    for (const [command, args] of [["where", ["adb"]], ["/bin/sh", ["-c", "command -v adb"]]] as const) {
        const lookup = spawnSync(command, [...args], { encoding: "utf8" });
        expect(lookup.status).toBe(0);
        expect(lookup.stdout.trim()).toBe(executable);
    }
    expect(spawnSync("where", ["unregistered-provider"], { encoding: "utf8" }).status).toBe(1);
    const args = ["a b", "한글", '"quoted"', "C:\\path\\file"];
    const result = spawnSync(executable, args, { encoding: "utf8" });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe("provider failed");
});
