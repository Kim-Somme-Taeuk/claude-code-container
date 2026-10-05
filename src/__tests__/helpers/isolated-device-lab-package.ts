import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Import a real copied package so package-owned assets can be replaced only inside a test fixture. */
export async function isolatedDeviceLabPackage(packageRoot: string): Promise<typeof import("@ccc/device-lab/device-lab-broker.js")> {
    const sourceRoot = fileURLToPath(new URL("../../../packages/device-lab/", import.meta.url));
    for (const name of ["package.json", "dist", "powershell"]) {
        cpSync(join(sourceRoot, name), join(packageRoot, name), { recursive: true });
    }
    const hyperVRoot = fileURLToPath(new URL("../../../packages/hyper-v/", import.meta.url));
    const installedHyperV = join(packageRoot, "node_modules", "@ccc", "hyper-v");
    mkdirSync(installedHyperV, { recursive: true });
    for (const name of ["package.json", "dist", "powershell"]) {
        cpSync(join(hyperVRoot, name), join(installedHyperV, name), { recursive: true });
    }
    // Providers are copied only when absent: callers can supply a bounded fake backend module.
    cpSync(join(sourceRoot, "providers"), join(packageRoot, "providers"), { recursive: true, force: false });
    return import(pathToFileURL(join(packageRoot, "dist", "device-lab-broker.js")).href);
}
