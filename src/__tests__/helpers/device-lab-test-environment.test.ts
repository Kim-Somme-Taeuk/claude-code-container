import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceLabTestHomeEnvironment, isolateDeviceLabTestEnvironment } from "./device-lab-test-environment.js";

const scratch: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporaryHome() {
    const root = mkdtempSync(join(tmpdir(), "ccc-home-isolation-"));
    scratch.push(root);
    return root;
}

describe("mock device provider home isolation", () => {
    it("isolates native homedir even when a Windows host is mocked as macOS", () => {
        const callerHome = temporaryHome();
        const fixtureHome = temporaryHome();
        vi.stubEnv("HOME", callerHome);
        vi.stubEnv("USERPROFILE", callerHome);
        vi.stubEnv("CCC_PROFILE", "caller-profile");
        vi.stubEnv("CCC_E2E_SKIP_BUILD", "1");
        vi.stubEnv("CCC_DEVICE_BROKER_AUTH_FILE", join(callerHome, "owner-auth.json"));
        vi.stubEnv("ANDROID_AVD_HOME", join(callerHome, "avds"));
        const restore = isolateDeviceLabTestEnvironment(fixtureHome);
        try {
            // os.homedir remains a native API: mocking process.platform does not
            // make Windows switch from USERPROFILE to HOME.
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            expect(homedir()).toBe(fixtureHome);
            expect(process.env.USERPROFILE).toBe(fixtureHome);
            expect(process.env.CCC_PROFILE).toBeUndefined();
            expect(process.env.CCC_E2E_SKIP_BUILD).toBe("1");
            expect(process.env.CCC_DEVICE_BROKER_AUTH_FILE).toBeUndefined();
            expect(process.env.ANDROID_AVD_HOME).toBeUndefined();
            process.env.CCC_PROFILE = "fixture-profile";
        } finally { restore(); }
        expect(process.env.HOME).toBe(callerHome);
        expect(process.env.USERPROFILE).toBe(callerHome);
        expect(process.env.CCC_PROFILE).toBe("caller-profile");
        expect(process.env.CCC_DEVICE_BROKER_AUTH_FILE).toBe(join(callerHome, "owner-auth.json"));
        expect(process.env.ANDROID_AVD_HOME).toBe(join(callerHome, "avds"));
    });

    it("overrides an inherited Windows profile before a child writes .ccc state", () => {
        const callerHome = temporaryHome();
        const fixtureHome = temporaryHome();
        const result = spawnSync(process.execPath, ["-e", `
            const fs = require('node:fs');
            const path = require('node:path');
            const root = path.join(require('node:os').homedir(), '.ccc', 'devices');
            fs.mkdirSync(root, {recursive:true});
            fs.writeFileSync(path.join(root, 'fixture.json'), '{}');
            process.stdout.write(JSON.stringify({home:require('node:os').homedir(),profile:process.env.USERPROFILE}));
        `], { encoding: "utf8", env: {
            ...process.env, HOME: callerHome, USERPROFILE: callerHome,
            ...deviceLabTestHomeEnvironment(fixtureHome),
        } });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ home: fixtureHome, profile: fixtureHome });
        expect(existsSync(join(fixtureHome, ".ccc", "devices", "fixture.json"))).toBe(true);
        expect(existsSync(join(callerHome, ".ccc"))).toBe(false);
    });
});
