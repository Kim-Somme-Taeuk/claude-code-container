import { join, win32 } from "node:path";

/** Override every home location inherited by the MCP SDK, including Windows. */
export function deviceLabTestHomeEnvironment(homeDir: string): Record<string, string> {
    const drive = win32.parse(homeDir).root.replace(/[\\/]$/, "");
    return {
        HOME: homeDir,
        USERPROFILE: homeDir,
        HOMEDRIVE: /^[A-Za-z]:$/.test(drive) ? drive : "",
        HOMEPATH: /^[A-Za-z]:$/.test(drive) ? homeDir.slice(drive.length) : homeDir,
        APPDATA: join(homeDir, "AppData", "Roaming"),
        LOCALAPPDATA: join(homeDir, "AppData", "Local"),
    };
}

// Build controls belong to the test runner, not the device owner/profile.
const inheritedDeviceSetting = (key: string) => /^(CCC_|ANDROID_)/i.test(key) && key.toUpperCase() !== "CCC_E2E_SKIP_BUILD";

/** Isolate in-process provider state and restore the caller's exact environment. */
export function isolateDeviceLabTestEnvironment(homeDir: string): () => void {
    const overrides = deviceLabTestHomeEnvironment(homeDir);
    const keys = new Set([...Object.keys(overrides), ...Object.keys(process.env).filter(inheritedDeviceSetting)]);
    const previous = new Map([...keys].map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, overrides);
    return () => {
        for (const key of Object.keys(process.env)) if (inheritedDeviceSetting(key)) delete process.env[key];
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}
