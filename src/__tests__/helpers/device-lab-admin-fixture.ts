import { isolateDeviceLabTestEnvironment } from "./device-lab-test-environment.js";
import * as childProcess from "child_process";
import { vi } from "vitest";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { deviceLabOwnerId } from "../../device-lab-admin.js";

export function createDeviceLabAdminTestFixture() {
    let restoreEnvironment: (() => void) | undefined;
    let restoreToolRouting: (() => void) | undefined;
    const nodeTools = new Map<string, string>();
    const originalPath = process.env.PATH;
    let homeDir: string | null = null;

    function physicalLeaseLockPath(stateKey: string, hardwareId: string) {
        return join(homeDir!, ".ccc/devices/physical-leases", stateKey, "locks", `${encodeURIComponent(hardwareId)}.json`);
    }

    function setupFixture(cwd: string, profile?: string) {
        homeDir = join(tmpdir(), `ccc-device-admin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        restoreEnvironment = isolateDeviceLabTestEnvironment(homeDir);
        process.env.PATH = "/tmp/ccc-device-admin-empty-path";
        const owner = deviceLabOwnerId(cwd, profile);
        const androidDir = join(homeDir, ".ccc/devices/owners", owner, "android");
        const androidDeviceDir = join(homeDir, ".ccc/devices/owners", owner, "android-device");
        const iosDir = join(homeDir, ".ccc/devices/owners", owner, "ios");
        const iosDeviceDir = join(homeDir, ".ccc/devices/owners", owner, "ios-device");
        const windowsDir = join(homeDir, ".ccc/devices/owners", owner, "windows");
        const macosDir = join(homeDir, ".ccc/devices/owners", owner, "macos");
        const otherOwnerDir = join(homeDir, ".ccc/devices/owners", "other-owner", "android");
        mkdirSync(androidDir, { recursive: true });
        mkdirSync(androidDeviceDir, { recursive: true });
        mkdirSync(iosDir, { recursive: true });
        mkdirSync(iosDeviceDir, { recursive: true });
        mkdirSync(windowsDir, { recursive: true });
        mkdirSync(macosDir, { recursive: true });
        mkdirSync(otherOwnerDir, { recursive: true });
        const androidFile = join(androidDir, "devices.json");
        const androidDeviceFile = join(androidDeviceDir, "devices.json");
        const iosFile = join(iosDir, "devices.json");
        const iosDeviceFile = join(iosDeviceDir, "devices.json");
        const windowsFile = join(windowsDir, "devices.json");
        const macosFile = join(macosDir, "devices.json");
        const otherOwnerFile = join(otherOwnerDir, "devices.json");
        writeFileSync(androidFile, JSON.stringify({
            devices: [
                { id: "android-owned", name: "Pixel", status: "stopped", platform: "android", serial: "emulator-5554" },
                { id: "android-running", name: "Pixel Running", status: "running", platform: "android", serial: "emulator-5582", pid: 999999 },
            ],
        }));
        writeFileSync(androidDeviceFile, JSON.stringify({
            devices: [
                { id: "android-real", name: "Real Pixel", status: "attached", platform: "android", physical: true, serial: "R5CREAL123" },
                { id: "android-real-recording", name: "Real Recording", status: "attached", platform: "android", physical: true, serial: "R5CREAL456", recording: { active: true, pid: 999998 } },
            ],
        }));
        writeFileSync(iosFile, JSON.stringify({
            devices: [
                { id: "ios-owned", name: "iPhone", status: "booted", platform: "ios", udid: "IOS-UDID" },
                { id: "ios-stopped", name: "iPhone Stopped", status: "stopped", platform: "ios", udid: "IOS-STOPPED" },
            ],
        }));
        writeFileSync(iosDeviceFile, JSON.stringify({
            devices: [
                { id: "ios-real", name: "Real iPhone", status: "attached", platform: "ios", physical: true, udid: "REAL-IOS-UDID", appium: { serverPid: 999997 } },
            ],
        }));
        writeFileSync(windowsFile, JSON.stringify({
            devices: [{ id: "windows-owned", name: "Win", status: "running", platform: "windows", sandboxId: "12345678-1234-4234-9234-1234567890ab" }],
        }));
        writeFileSync(macosFile, JSON.stringify({
            devices: [
                { id: "macos-owned", name: "Mac", status: "running", platform: "macos", provider: "tart", providerInstance: "ccc-mac" },
                { id: "macos-stopped", name: "Mac Stopped", status: "stopped", platform: "macos", provider: "tart", providerInstance: "ccc-mac-stopped" },
            ],
        }));
        writeFileSync(otherOwnerFile, JSON.stringify({
            devices: [{ id: "android-foreign", name: "Foreign", status: "running", platform: "android", serial: "emulator-5596" }],
        }));
        for (const [stateKey, hardwareId, deviceId] of [
            ["android-device", "R5CREAL123", "android-real"],
            ["android-device", "R5CREAL456", "android-real-recording"],
            ["ios-device", "REAL-IOS-UDID", "ios-real"],
        ]) {
            const lock = physicalLeaseLockPath(stateKey, hardwareId);
            mkdirSync(dirname(lock), { recursive: true });
            writeFileSync(lock, JSON.stringify({ backend: stateKey, hardwareId, ownerId: owner, deviceId }));
        }
        const foreignLock = physicalLeaseLockPath("android-device", "FOREIGN-REAL");
        mkdirSync(dirname(foreignLock), { recursive: true });
        writeFileSync(foreignLock, JSON.stringify({ backend: "android-device", hardwareId: "FOREIGN-REAL", ownerId: "other-owner", deviceId: "foreign-real" }));
        return { owner, androidFile, androidDeviceFile, iosFile, iosDeviceFile, windowsFile, macosFile, otherOwnerFile };
    }

    function readDeviceIds(file: string) {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as { devices: Array<{ id: string; status?: string }> };
        return parsed.devices.map((device) => `${device.id}:${device.status || "unknown"}`);
    }

    function readDevices(file: string) {
        return (JSON.parse(readFileSync(file, "utf-8")) as { devices: Array<Record<string, unknown>> }).devices;
    }

    function writeTool(binDir: string, name: string, body: string) {
        const path = join(binDir, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
    }

    // The cleanup tests exercise process effects and timeouts, not OS executable discovery.
    // Route only their registered tools to real Node children, avoiding shell/where dependencies.
    function writeNodeTool(binDir: string, name: string, body: string) {
        if (!restoreToolRouting) {
            const originalSpawn = childProcess.spawnSync;
            const spy = vi.spyOn(childProcess, "spawnSync").mockImplementation(((command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
                const lookup = command === "where" ? args[0]
                    : command === "/bin/sh" && args[0] === "-c" && args[1]?.startsWith("command -v ") ? args[1].slice(11) : undefined;
                if (lookup !== undefined) {
                    const path = nodeTools.get(lookup);
                    return { status: path ? 0 : 1, signal: null, pid: 0, stdout: path ? `${path}\n` : "", stderr: "", output: [null, path ? `${path}\n` : "", ""] };
                }
                if ([...nodeTools.values()].includes(command)) {
                    return originalSpawn(process.execPath, [command, ...args], options);
                }
                return originalSpawn(command, args, options);
            }) as typeof childProcess.spawnSync);
            restoreToolRouting = () => spy.mockRestore();
        }
        const path = join(binDir, `${name}.mjs`);
        writeFileSync(path, `import { appendFileSync, writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\n${body}\n`);
        nodeTools.set(name, path);
        return path;
    }

    function cleanup() {
        restoreToolRouting?.();
        restoreToolRouting = undefined;
        nodeTools.clear();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        homeDir = null;
        restoreEnvironment?.();
        restoreEnvironment = undefined;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    }

    return {
        get homeDir() {
            if (!homeDir) throw new Error("device-lab admin fixture has not been set up");
            return homeDir;
        },
        cleanup,
        physicalLeaseLockPath,
        readDeviceIds,
        readDevices,
        setupFixture,
        writeTool,
        writeNodeTool,
    };
}
