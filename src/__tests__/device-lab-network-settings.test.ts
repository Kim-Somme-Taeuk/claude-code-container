import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ calls: [] as string[][], fail: "" }));
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    commandPath: (name: string) => name,
    run: (_command: string, args: string[]) => {
        fixture.calls.push(args);
        const failed = fixture.fail && fixture.fail.split("|").some(part => args.join(" ").includes(part));
        return { status: failed ? 1 : 0, stdout: "", stderr: failed ? "fixture failure" : "" };
    },
}));
vi.mock("@ccc/device-lab/providers/state/android-state.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    findAndroidDevice: () => ({ id: "phone", serial: "emulator-5554" }),
}));
vi.mock("@ccc/device-lab/providers/state/device-store.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    withOwnerDeviceOperation: (_backend: string, _id: string, action: () => unknown) => action(),
}));
import { handleAndroidTool } from "@ccc/device-lab/providers/backends/android.mjs";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";

beforeEach(() => { fixture.calls = []; fixture.fail = ""; });
const network = (args: Record<string, unknown>) => handleAndroidTool("mobile_set_network", { deviceId: "phone", ...args });
const commands = () => fixture.calls.map(args => args.slice(args.indexOf("shell") + 1).join(" "));

describe("combined Android network settings", () => {
    it("sets airplane mode before explicit radio overrides, preserving false", async () => {
        const result = await network({ airplaneMode: false, wifi: true, data: false });
        expect(result?.isError).not.toBe(true);
        expect(commands()).toEqual(["cmd connectivity airplane-mode disable", "svc wifi enable", "svc data disable"]);
    });
    it("accepts airplane mode alone and retains the existing older Android fallback", async () => {
        fixture.fail = "cmd connectivity";
        expect((await network({ airplaneMode: true }))?.isError).not.toBe(true);
        expect(commands()).toEqual([
            "cmd connectivity airplane-mode enable", "settings put global airplane_mode_on 1",
            "am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true",
        ]);
    });
    it.each([{}, { wifi: "false" }, { airplaneMode: true, data: null }])("rejects all malformed input before commands: %j", async args => {
        expect((await network(args))?.isError).toBe(true);
        expect(fixture.calls).toEqual([]);
    });
    it("stops on a later failure and retains partial execution evidence in compact output", async () => {
        fixture.fail = "svc wifi";
        const raw = await network({ airplaneMode: true, wifi: false, data: true });
        expect(raw?.isError).toBe(true);
        expect(commands()).toEqual(["cmd connectivity airplane-mode enable", "svc wifi disable"]);
        const result = actionResult("set_network", "mobile_set_network", raw);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ error: "android-network-command-failed", detail: "wifi", applied: ["airplaneMode"] });
    });
    it("reports a legacy airplane setting applied before broadcast failure", async () => {
        fixture.fail = "cmd connectivity|am broadcast";
        const raw = await network({ airplaneMode: true, wifi: true });
        const result = actionResult("set_network", "mobile_set_network", raw);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ detail: "airplaneMode.broadcast", applied: ["airplaneMode.setting"] });
        expect(commands()).toHaveLength(3);
        expect(commands().some(command => command.startsWith("svc"))).toBe(false);
    });
});
