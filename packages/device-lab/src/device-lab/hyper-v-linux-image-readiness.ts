import type { HyperVReadiness } from "../host-control/hyper-v/index.js";
import type { HyperVUbuntuImageCacheInspection } from "./broker/hyper-v/image-store.js";

// One linux-vm image readiness decision for the smoke, device_backends, the setup diagnostic and
// the Level 3 Linux E2E gate, so they cannot disagree. qemu-img runs only to acquire the ubuntu-lts
// base image: create reuses a cached image after its own full SHA-256 check and never starts
// qemu-img then. So a cache whose manifest metadata validates turns the qemu-img state into an
// advisory, a cache conflict blocks with its own code, and only a host that still has to acquire
// the image is blocked by qemu-img. Everything here is pure; callers inspect the cache.

type HyperVLinuxImageReadinessInput = Pick<HyperVReadiness, "linuxImageMissing" | "qemuImgSignatureStatus"> | null;

export type HyperVLinuxImageReadiness = {
    // Codes that keep create from getting a base image now; empty when it can.
    blockers: string[];
    // qemu-img codes that do not block because create reuses the cached image.
    advisories: string[];
    baseImage: { state: HyperVUbuntuImageCacheInspection["state"]; source: "owner" | "global" | null };
    // Whether a fresh acquisition could run; null when the readiness probe gave no answer.
    imageAcquisition: { available: boolean; missing: string[] } | null;
};

export function hyperVLinuxImageBlockers(
    readiness: HyperVLinuxImageReadinessInput,
    cache: HyperVUbuntuImageCacheInspection,
): HyperVLinuxImageReadiness {
    const acquisitionMissing = [...(readiness?.linuxImageMissing || [])];
    const baseImage = { state: cache.state, source: cache.source ?? null };
    const imageAcquisition = readiness ? { available: acquisitionMissing.length === 0, missing: [...acquisitionMissing] } : null;
    if (cache.state === "valid") return { blockers: [], advisories: acquisitionMissing, baseImage, imageAcquisition };
    if (cache.state === "conflict") return { blockers: [cache.code], advisories: [], baseImage, imageAcquisition };
    return { blockers: acquisitionMissing, advisories: [], baseImage, imageAcquisition };
}

// The skip reason for a blocked image, shared by the smoke and the E2E gate. An untrusted qemu-img
// carries the probe's closed signature status so a results file can tell the causes apart.
export function hyperVLinuxImageSkipReason(readiness: HyperVLinuxImageReadinessInput, image: HyperVLinuxImageReadiness): string {
    const status = image.blockers.includes("hyper-v-qemu-img-untrusted") && readiness?.qemuImgSignatureStatus
        ? ` (qemu-img signature ${readiness.qemuImgSignatureStatus})`
        : "";
    return `missing ${image.blockers.join(", ")}${status}`;
}

function qemuImgAdvisory(readiness: HyperVLinuxImageReadinessInput, advisories: string[]): string | null {
    if (advisories.includes("hyper-v-qemu-img-unavailable")) return "qemu-img unavailable";
    if (advisories.includes("hyper-v-qemu-img-untrusted")) {
        return `qemu-img untrusted${readiness?.qemuImgSignatureStatus ? ` (signature ${readiness.qemuImgSignatureStatus})` : ""}`;
    }
    return advisories.length > 0 ? advisories.join(", ") : null;
}

// The linux-vm smoke outcome once Hyper-V, SSH and SCP are known to be ready. A cache hit never
// claims a trusted qemu-img; it names the cached image and reports qemu-img only as an advisory.
export function hyperVLinuxSmokeImageResult(
    readiness: HyperVLinuxImageReadinessInput,
    cache: HyperVUbuntuImageCacheInspection,
): { status: "PASS" | "SKIP"; detail: string } {
    const image = hyperVLinuxImageBlockers(readiness, cache);
    if (image.blockers.length > 0) return { status: "SKIP", detail: hyperVLinuxImageSkipReason(readiness, image) };
    if (image.baseImage.state !== "valid") {
        return { status: "PASS", detail: "Hyper-V, trusted qemu-img, SSH, and SCP are ready; no VM started" };
    }
    const advisory = qemuImgAdvisory(readiness, image.advisories);
    return {
        status: "PASS",
        detail: `Hyper-V, cached ubuntu-lts base image, SSH, and SCP are ready; ${advisory ? `${advisory}, needed only to re-acquire the image; ` : ""}no VM started`,
    };
}
