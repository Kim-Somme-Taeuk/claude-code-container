import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDeviceLabPathWithinRoot, readDeviceLabTextFile } from "#device-lab/providers/state/state-file.mjs";

const LOG_NAMES = [
    "ccc-guest-helper-bootstrap.stdout.txt", "ccc-guest-helper-bootstrap.stderr.txt",
    "ccc-guest-helper.stdout.txt", "ccc-guest-helper.stderr.txt",
    "ccc-guest-helper-bootstrap.ready.txt", "ccc-guest-helper.ready.txt",
    "ccc-guest-helper.heartbeat.txt",
    "ccc-guest-helper-bootstrap-phase.json",
] as const;

// This is a private local raw-log bundle, never part of sanitized MCP evidence.
// Derive every source from the test's owner/device, not a provider-returned path.
export function captureWindowsSandboxBootstrapEvidence(options: {
    homeDir: string; ownerId: string; deviceId: string; artifactRoot: string;
}): { artifact: string } | { error: "bootstrap-evidence-capture-failed" } {
    try {
        if (!/^[a-f0-9]{16}$/.test(options.ownerId)
            || !/^windows-real-sandbox-[0-9]{1,20}$/.test(options.deviceId)) throw new Error("identity-invalid");
        const downloads = join(options.homeDir, ".ccc", "devices", "owners", options.ownerId, "windows", options.deviceId, "downloads");
        const files: Record<string, { status: string; text?: string }> = {};
        for (const name of LOG_NAMES) {
            try {
                const source = join(downloads, name);
                assertDeviceLabPathWithinRoot(options.homeDir, source, "bootstrap-evidence");
                const text = readDeviceLabTextFile(source, "bootstrap-evidence", 8192);
                files[name] = text === null ? { status: "absent" } : { status: "captured", text };
            } catch (error: any) {
                files[name] = { status: error?.code === "bootstrap-evidence-file-too-large" ? "too-large" : "unreadable" };
            }
        }
        const artifact = `results/device-lab-real/windows-sandbox-bootstrap-${randomUUID()}.json`;
        const destination = join(options.artifactRoot, artifact);
        // Fence each existing ancestor before creating its immediate child.
        for (const directory of [join(options.artifactRoot, "results"), join(options.artifactRoot, "results", "device-lab-real")]) {
            assertDeviceLabPathWithinRoot(options.artifactRoot, directory, "bootstrap-evidence-output");
            if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
        }
        assertDeviceLabPathWithinRoot(options.artifactRoot, destination, "bootstrap-evidence-output");
        writeFileSync(destination, JSON.stringify({ schemaVersion: 1,
            privacy: "Private local raw helper logs. May contain host paths or credentials; do not publish automatically.",
            files }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        return { artifact };
    } catch {
        return { error: "bootstrap-evidence-capture-failed" };
    }
}
