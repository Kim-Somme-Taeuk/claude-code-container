import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const command = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@ccc/device-lab/providers/commands.mjs", () => ({ run: command.run }));
import { androidCreationChoices } from "@ccc/device-lab/providers/backends/android-sdk-inventory.mjs";
import { createInputError } from "../../device-lab-mcp/src/creation-input.mjs";

let root: string;
const file = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "fixture"); return path; };
const image = (sdk: string, abi = "x86_64") => file(join(sdk, "system-images", "android-35", "google_apis", abi, "system.img"));
const manager = (sdk: string) => file(join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"));
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-sdk-inventory-"));
    command.run.mockReset().mockReturnValue({ status: 0, stdout: 'Available devices definitions:\nid: 0 or "pixel_8"\n    Name: Pixel 8\nid: 1 or "Nexus 5"\n', stderr: "" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Android first-create choices", () => {
    it("returns copyable installed IDs even when there are no AVDs", () => {
        const sdk = join(root, "sdk"); image(sdk);
        mkdirSync(join(sdk, "system-images", "android-35", "google_apis", "partial"), { recursive: true });
        const avdmanager = manager(sdk);
        const result = androidCreationChoices({ avdmanager }, [sdk, sdk]);
        expect(result).toEqual({ systemImages: ["system-images;android-35;google_apis;x86_64"], deviceProfiles: ["Nexus 5", "pixel_8"] });
        expect(createInputError({ backend: "android-emulator", name: "new-phone", systemImage: result.systemImages[0], deviceProfile: result.deviceProfiles[0] })).toBeNull();
        expect(command.run).toHaveBeenCalledWith(avdmanager, ["list", "device"], { timeout: 5000, maxBuffer: 262144 });
    });
    it("resolves a selected tool symlink and excludes stale SDK candidates", (context) => {
        const active = join(root, "active"), stale = join(root, "stale"); image(active, "arm64-v8a"); image(stale);
        const link = join(root, "avdmanager-link");
        try { symlinkSync(manager(active), link); }
        catch (error) {
            if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
                context.skip(true, "Windows file symlinks require Developer Mode or privilege"); return;
            }
            throw error;
        }
        expect(androidCreationChoices({ avdmanager: link }, [stale]).systemImages).toEqual(["system-images;android-35;google_apis;arm64-v8a"]);
    });
    it("uses selected emulator or configured SDK when manager path has no SDK layout", () => {
        const sdk = join(root, "sdk"); image(sdk);
        const emulator = file(join(sdk, "emulator", "emulator"));
        const wrapper = file(join(root, "wrapper"));
        expect(androidCreationChoices({ avdmanager: wrapper, emulator }, []).systemImages).toHaveLength(1);
        expect(androidCreationChoices({ avdmanager: wrapper }, [sdk]).systemImages).toHaveLength(1);
    });
    it("reports missing SDK/profiles separately from an installed SDK with no images", () => {
        expect(androidCreationChoices({}, [join(root, "missing")])).toEqual({ systemImages: [], deviceProfiles: [], creationDiscovery: {
            diagnostics: ["android-sdk-not-found", "android-device-profiles-unavailable"],
        } });
        expect(androidCreationChoices({ avdmanager: manager(root) }, []).systemImages).toEqual([]);
    });
    it("does not follow linked directories outside the SDK", () => {
        const sdk = join(root, "sdk"), outside = join(root, "outside"); image(outside);
        mkdirSync(join(sdk, "system-images"), { recursive: true });
        symlinkSync(join(outside, "system-images", "android-35"), join(sdk, "system-images", "android-35"), process.platform === "win32" ? "junction" : "dir");
        expect(androidCreationChoices({ avdmanager: manager(sdk) }, []).systemImages).toEqual([]);
    });
    it.each([
        { status: 1, stdout: "", stderr: "failed" },
        { status: null, stdout: "", error: { code: "ETIMEDOUT" } },
        { status: null, stdout: "", error: { code: "ENOBUFS" } },
        { status: 0, stdout: "unexpected format" },
    ])("keeps profile discovery failures visible: %j", result => {
        image(root); command.run.mockReturnValue(result);
        const choices = androidCreationChoices({ avdmanager: manager(root) }, []);
        expect(choices.systemImages).toHaveLength(1);
        expect(choices.deviceProfiles).toEqual([]);
        expect(choices.creationDiscovery?.diagnostics).toHaveLength(1);
    });
    it("caps output and records incomplete discovery instead of silently truncating", () => {
        command.run.mockReturnValue({ status: 0, stdout: "x".repeat(262145) });
        expect(androidCreationChoices({ avdmanager: manager(root) }, []).creationDiscovery).toMatchObject({ truncated: true });
        command.run.mockReturnValue({ status: 0, stdout: Array.from({ length: 257 }, (_, i) => `id: ${i} or "device_${i}"`).join("\n") });
        for (let i = 0; i < 257; i++) image(root, `abi_${i}`);
        const result = androidCreationChoices({ avdmanager: manager(root) }, []);
        expect(result.systemImages).toHaveLength(256);
        expect(result.deviceProfiles).toHaveLength(256);
        expect(result.creationDiscovery).toEqual({ truncated: true });
    });
    it("marks a mixed valid and malformed profile listing as incomplete", () => {
        command.run.mockReturnValue({ status: 0, stdout: 'id: 0 or "pixel_8"\nid: 1 or "broken/profile"\n' });
        expect(androidCreationChoices({ avdmanager: manager(root) }, [])).toMatchObject({
            deviceProfiles: ["pixel_8"],
            creationDiscovery: { diagnostics: ["android-device-profiles-unrecognized-output"] },
        });
    });
    it("bounds filesystem enumeration even when there are no usable images", () => {
        const path = join(root, "system-images"); mkdirSync(path);
        for (let i = 0; i < 4097; i++) mkdirSync(join(path, `android-${i}`));
        expect(androidCreationChoices({ avdmanager: manager(root) }, []).creationDiscovery).toMatchObject({ truncated: true });
    });
});
