import { describe, expect, it, vi } from "vitest";
import { readAndroidAvdIdentity } from "@ccc/device-lab/providers/state/android-avd-identity.mjs";

describe("Android console AVD identity", () => {
    const serial = "emulator-5638";
    const normal = ["-s", serial, "emu", "avd", "name"];
    const retry = ["-s", serial, "emu", "avd name\navd name"];
    const success = (stdout: string) => ({ status: 0, stdout, stderr: "" });

    it("accepts the normal console reply with one read-only command", async () => {
        const run = vi.fn().mockReturnValue(success("Pixel_8-API.35\r\nOK\r\n"));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Pixel_8-API.35" });
        expect(run.mock.calls).toEqual([[normal]]);
    });

    it.each(["", " \r\n", "OK\r\nOK\r\n"])("retries successful stripped output %j exactly once", async first => {
        const run = vi.fn().mockReturnValueOnce(success(first))
            .mockReturnValueOnce(success("Other_Project_AVD\nOther_Project_AVD\nOK\n"));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it("accepts the one name retained after ADB strips the retry's first reply", () => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce(success("Other_Project_AVD\r\nOK\r\n"));
        expect(readAndroidAvdIdentity(serial, run)).toEqual({ ok: true, name: "Other_Project_AVD" });
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        ["still empty", ""], ["only OK", "OK\n"],
        ["conflicting names", "Pixel_A\nPixel_B\nOK\n"],
        ["invalid name", "../Pixel_A\nOK\n"],
        ["console error", "KO: unknown command\n"],
        ["name followed by error", "Pixel_A\nKO: failed\n"],
    ])("rejects %s from the compatibility retry", async (_label, output) => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce(success(output));
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal], [retry]]);
    });

    it.each([
        { status: 1, stdout: "", stderr: "" },
        { status: null, stdout: "", stderr: "" },
        { status: 0, stdout: "", stderr: "console failed" },
        { status: 0, stdout: "", error: new Error("timeout") },
        success("KO: authentication required\n"),
        success("Pixel_A\nPixel_B\n"),
        success("Invalid Name\n"),
    ])("does not retry a failed or invalid normal response %#", async result => {
        const run = vi.fn().mockReturnValue(result);
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run.mock.calls).toEqual([[normal]]);
    });

    it("rejects a failed retry even when stdout contains a plausible name", async () => {
        const run = vi.fn().mockReturnValueOnce(success(""))
            .mockReturnValueOnce({ status: 1, stdout: "Pixel_A\n", stderr: "" });
        expect(await readAndroidAvdIdentity(serial, run)).toEqual(expect.objectContaining({ ok: false }));
        expect(run).toHaveBeenCalledTimes(2);
    });
});
