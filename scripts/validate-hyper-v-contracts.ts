import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { HYPER_V_POWERSHELL_MANIFEST } from "#device-lab/host-control/hyper-v/powershell-manifest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "packages", "device-lab", "powershell");
const libraryAssetRoot = join(repoRoot, "packages", "hyper-v", "powershell");

function filesUnder(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

if (HYPER_V_POWERSHELL_MANIFEST.schemaVersion !== 1 || Object.keys(HYPER_V_POWERSHELL_MANIFEST.operations).length === 0) {
    throw new Error("Hyper-V PowerShell command manifest is empty or invalid");
}

for (const [name, metadata] of Object.entries(HYPER_V_POWERSHELL_MANIFEST.assets)) {
    const root = name === "Invoke-HyperVWindowsOperation.ps1" ? libraryAssetRoot : assetRoot;
    const realRoot = realpathSync(root);
    const file = realpathSync(join(root, name));
    const displacement = relative(realRoot, file);
    if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement) || !lstatSync(file).isFile()) {
        throw new Error(`Hyper-V PowerShell asset escapes package root: ${name}`);
    }
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (digest !== metadata.sha256) throw new Error(`Hyper-V PowerShell asset digest mismatch: ${name}`);
}
for (const [operation, entry] of Object.entries(HYPER_V_POWERSHELL_MANIFEST.operations)) {
    if (entry.requestVersion !== 1 || !(entry.script in HYPER_V_POWERSHELL_MANIFEST.assets)) {
        throw new Error(`Invalid Hyper-V PowerShell operation: ${operation}`);
    }
}

for (const file of [...filesUnder(assetRoot), ...filesUnder(libraryAssetRoot)].filter((candidate) => /\.ps(?:1|m1)$/i.test(candidate))) {
    const source = readFileSync(file);
    if (source.includes(0)) throw new Error(`NUL byte in PowerShell asset: ${relative(repoRoot, file)}`);
    const text = source.toString("utf8");
    if (text.includes("\uFFFD")) throw new Error(`Invalid UTF-8 in PowerShell asset: ${relative(repoRoot, file)}`);
    if (/__[A-Z][A-Z0-9_]{2,}__/.test(text)) throw new Error(`Unresolved template token in PowerShell asset: ${relative(repoRoot, file)}`);
}

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (!packageJson.files?.some((entry: string) => ["dist", "dist/", "dist/packages", "dist/packages/"].includes(entry))) {
    throw new Error("npm package omits embedded workspace PowerShell assets");
}
for (const name of ["device-lab", "hyper-v"]) {
    const workspace = JSON.parse(readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"));
    if (!workspace.files?.some((entry: string) => ["powershell", "powershell/"].includes(entry))) {
        throw new Error(`workspace package omits Hyper-V PowerShell assets: ${name}`);
    }
}

console.log(`PASS Hyper-V PowerShell contracts operations=${Object.keys(HYPER_V_POWERSHELL_MANIFEST.operations).length}`);
