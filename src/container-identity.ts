import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { getRuntimeInfo, runtimeCli, type RuntimeInfo } from "./container-runtime.js";
import { withSharedMutationLock } from "./device-lab-shared-state.js";

export const IDENTITY_CONTRACT_VERSION = "1";

export interface ContainerIdentity {
    uid: number;
    gid: number;
    mapping: "host" | "podman-keep-id" | "desktop";
    contractVersion: string;
}

function validateId(value: number | undefined, name: string): asserts value is number {
    if (!Number.isSafeInteger(value) || value! <= 0 || value! >= 4294967295) {
        throw new Error(`Invalid host ${name}: ${value}. Run CCC as a non-root user with a valid UID and GID.`);
    }
}

export function resolveContainerIdentity(
    runtime: RuntimeInfo = getRuntimeInfo(),
    platform: NodeJS.Platform = process.platform,
    uid: number | undefined = process.geteuid?.(),
    gid: number | undefined = process.getegid?.(),
): ContainerIdentity {
    if (runtime.runtime === "docker" && (runtime.rootless || runtime.flavor === "docker-rootless")) {
        throw new Error("Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership.");
    }
    if (runtime.runtime === "podman" && (runtime.rootless || runtime.flavor === "podman-machine")) {
        return { uid: 1000, gid: 1000, mapping: "podman-keep-id", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    if (platform !== "linux") {
        return { uid: 1000, gid: 1000, mapping: "desktop", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    // WSL Linux files retain numeric ownership even with Docker Desktop.
    validateId(uid, "UID");
    validateId(gid, "GID");
    return { uid, gid, mapping: "host", contractVersion: IDENTITY_CONTRACT_VERSION };
}

export function getIdentityLabels(identity: ContainerIdentity): Record<string, string> {
    return {
        "ccc.identity.version": identity.contractVersion,
        "ccc.identity.uid": String(identity.uid),
        "ccc.identity.gid": String(identity.gid),
        "ccc.identity.mapping": identity.mapping,
    };
}

export function getIdentityMiseVolumeName(identity: ContainerIdentity): string {
    return `ccc-mise-cache-v${identity.contractVersion}-${identity.mapping}-${identity.uid}-${identity.gid}`;
}

function checked(args: string[], input?: string): string {
    const result = spawnSync(runtimeCli(), args, { encoding: "utf-8", input, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
        throw new Error(`Container identity ${args[0]} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    return result.stdout.trim();
}

function validatedImage(name: string, labels: Record<string, string>, identity: ContainerIdentity): string | null {
    const result = spawnSync(runtimeCli(), ["image", "inspect", name], { encoding: "utf-8", timeout: 30_000 });
    if (result.error || result.status !== 0) return null;
    try {
        const [image] = JSON.parse(result.stdout);
        if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Config?.User !== "ccc") return null;
        if (!Object.entries(labels).every(([key, value]) => image.Config.Labels?.[key] === value)) return null;
        const script = 'set -eu; test "$(id -un)" = ccc; test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc; test "$(getent group ccc | cut -d: -f3)" = "$(id -g)"; sudo -n true; printf "%s:%s:%s:ccc\\n" "$(id -u)" "$(id -g)" "$HOME"';
        const observed = checked(["run", "--rm", "--network", "none", "--user", "ccc", "--entrypoint", "/bin/sh", image.Id, "-c", script]);
        return observed === `${identity.uid}:${identity.gid}:/home/ccc:ccc` ? image.Id : null;
    } catch {
        return null;
    }
}

/** Build-time account changes have no access to projects or credentials. */
export function ensureIdentityImage(baseImageId: string, identity: ContainerIdentity): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(baseImageId)) throw new Error("Container identity requires an immutable sha256 base image ID.");
    validateId(identity.uid, "UID");
    validateId(identity.gid, "GID");
    if (!/^[a-zA-Z0-9.-]+$/.test(identity.contractVersion) || !["host", "podman-keep-id", "desktop"].includes(identity.mapping)) {
        throw new Error("Invalid container identity contract.");
    }
    const labels = { ...getIdentityLabels(identity), "ccc.identity.base": baseImageId };
    const key = createHash("sha256").update(JSON.stringify(labels)).digest("hex");
    const name = `ccc-identity:${key}`;
    const lock = join(homedir(), ".ccc", "locks", `identity-${key}.lock`);
    return withSharedMutationLock(lock, () => {
        const cached = validatedImage(name, labels, identity);
        if (cached) return cached;
        // FROM sha256:<id> is parsed as a registry name by some builders.
        // A content-addressed local tag works with Docker and Podman.
        const baseTag = `ccc-identity-base:${baseImageId.slice(7)}`;
        checked(["tag", baseImageId, baseTag]);
        const { uid, gid } = identity;
        const reconcile = [
            "set -eu",
            'old_uid=$(id -u ccc)',
            'old_gid=$(id -g ccc)',
            `collision=$(getent passwd ${uid} | cut -d: -f1 || true)`,
            'if [ -n "$collision" ] && [ "$collision" != ccc ]; then ' +
                `if [ "${uid}" = 1000 ] && [ "$collision" = ubuntu ] && [ "$(getent passwd ubuntu | cut -d: -f6)" = /home/ubuntu ]; then userdel ubuntu; ` +
                'else echo "Target UID belongs to an unrelated image account" >&2; exit 1; fi; fi',
            `groupmod -o -g ${gid} ccc`,
            `usermod -u ${uid} -g ccc ccc`,
            // usermod can update HOME first. Track old IDs before changing
            // either account; only matching owners/groups are reconciled.
            'for dir in /home/ccc /opt/ccc /host-stage; do if [ -d "$dir" ] && [ ! -L "$dir" ]; then ' +
                `find -P "$dir" -xdev -uid "$old_uid" -exec chown -h ${uid} {} +; ` +
                `find -P "$dir" -xdev -gid "$old_gid" -exec chgrp -h ${gid} {} +; fi; done`,
            `test "$(id -u ccc)" = ${uid}`,
            `test "$(id -g ccc)" = ${gid}`,
            'test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc',
        ].join("; ");
        const dockerfile = [
            `FROM ${baseTag}`,
            "USER root",
            `RUN ${reconcile}`,
            "ENV HOME=/home/ccc",
            ...Object.entries(labels).map(([key, value]) => `LABEL ${key}="${value}"`),
            "USER ccc",
            "",
        ].join("\n");
        checked(["build", "--pull=false", "-t", name, "-"], dockerfile);
        const built = validatedImage(name, labels, identity);
        if (!built) {
            // Remove only this derived tag, never the base or another image.
            checked(["image", "rm", name]);
            throw new Error("Built container identity image failed UID/GID, HOME, sudo or named-user validation. Retry after correcting the base image.");
        }
        return built;
    }, { waitMs: 600_000, reclaimStale: false });
}
