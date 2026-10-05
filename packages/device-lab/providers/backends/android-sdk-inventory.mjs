import { opendirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { run } from "../commands.mjs";

const ENTRY_LIMIT = 4096;
const RESULT_LIMIT = 256;
const PROFILE_OUTPUT_LIMIT = 256 * 1024;
const identifier = /^[A-Za-z0-9._-]+$/;

function sdkFromTool(tool) {
    if (!tool) return null;
    try {
        const parent = dirname(realpathSync(tool));
        if (["emulator", "platform-tools"].includes(basename(parent))) return dirname(parent);
        if (basename(parent) === "bin") {
            const tools = dirname(parent);
            if (["tools", "cmdline-tools"].includes(basename(tools))) return dirname(tools);
            if (basename(dirname(tools)) === "cmdline-tools") return dirname(dirname(tools));
        }
    } catch { /* Fall back to other selected tools or configured SDK locations. */ }
    return null;
}

// Prefer the tools that will provision this AVD over unrelated installed SDKs.
function selectedSdk(discovery, candidates) {
    for (const tool of [discovery.avdmanager, discovery.emulator, discovery.adb]) {
        const sdk = sdkFromTool(tool);
        if (sdk) return sdk;
    }
    for (const candidate of [...new Set(candidates.map(path => resolve(path)))]) {
        try {
            if (statSync(candidate).isDirectory()) return realpathSync(candidate);
        } catch { /* An uninstalled candidate is not an inventory failure. */ }
    }
    return null;
}

export function androidCreationChoices(discovery, sdkCandidates, runCommand = run) {
    const systemImages = [];
    const deviceProfiles = [];
    const diagnostics = new Set();
    const sdk = selectedSdk(discovery, sdkCandidates);
    let entries = 0;
    let truncated = false;
    function directories(path) {
        const names = [];
        let directory;
        try {
            directory = opendirSync(path);
            let entry;
            while ((entry = directory.readSync())) {
                if (++entries > ENTRY_LIMIT) { truncated = true; break; }
                // Do not follow directory links outside the selected SDK tree.
                if (entry.isDirectory() && identifier.test(entry.name)) names.push(entry.name);
            }
        } catch (error) {
            if (error.code !== "ENOENT") diagnostics.add("android-image-inventory-unavailable");
        } finally { directory?.closeSync(); }
        return names.sort();
    }
    if (!sdk) diagnostics.add("android-sdk-not-found");
    else {
        const imagesRoot = join(sdk, "system-images");
        imageScan: for (const api of directories(imagesRoot)) {
            for (const tag of directories(join(imagesRoot, api))) {
                for (const abi of directories(join(imagesRoot, api, tag))) {
                    try {
                        if (!statSync(join(imagesRoot, api, tag, abi, "system.img")).isFile()) continue;
                    } catch (error) {
                        if (error.code !== "ENOENT") diagnostics.add("android-image-inventory-unavailable");
                        continue;
                    }
                    if (systemImages.length === RESULT_LIMIT) { truncated = true; break imageScan; }
                    const id = `system-images;${api};${tag};${abi}`;
                    if (id.length <= 256) systemImages.push(id);
                    else diagnostics.add("android-image-identifier-invalid");
                }
                if (entries > ENTRY_LIMIT) break imageScan;
            }
            if (entries > ENTRY_LIMIT) break;
        }
    }
    if (!discovery.avdmanager) diagnostics.add("android-device-profiles-unavailable");
    else {
        const result = runCommand(discovery.avdmanager, ["list", "device"], { timeout: 5000, maxBuffer: PROFILE_OUTPUT_LIMIT });
        if (result.status !== 0 || result.error || result.signal) diagnostics.add("android-device-profiles-unavailable");
        else if (Buffer.byteLength(result.stdout || "", "utf8") > PROFILE_OUTPUT_LIMIT) {
            diagnostics.add("android-device-profiles-output-too-large");
            truncated = true;
        } else {
            const ids = new Set();
            for (const line of (result.stdout || "").split(/\r?\n/)) {
                if (!/^\s*id:/.test(line)) continue;
                const match = line.match(/^\s*id:\s*\d+\s+or\s+"([A-Za-z0-9._ -]+)"\s*$/);
                if (!match) {
                    diagnostics.add("android-device-profiles-unrecognized-output");
                    continue;
                }
                if (match[1].length > 128 || match[1].trim() !== match[1]) {
                    diagnostics.add("android-device-profile-identifier-invalid");
                    continue;
                }
                if (ids.has(match[1])) continue;
                if (ids.size === RESULT_LIMIT) { truncated = true; break; }
                ids.add(match[1]);
            }
            deviceProfiles.push(...[...ids].sort());
            if (!deviceProfiles.length) diagnostics.add("android-device-profiles-unrecognized-output");
        }
    }
    return {
        systemImages,
        deviceProfiles,
        ...(diagnostics.size || truncated ? { creationDiscovery: {
            ...(diagnostics.size ? { diagnostics: [...diagnostics] } : {}),
            ...(truncated ? { truncated: true } : {}),
        } } : {}),
    };
}
