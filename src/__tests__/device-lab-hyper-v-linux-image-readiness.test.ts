import { describe, expect, it } from "vitest";
import type { HyperVUbuntuImageCacheInspection } from "@ccc/device-lab/device-lab/broker/hyper-v/image-store.js";
import {
    hyperVLinuxImageBlockers,
    hyperVLinuxImageSkipReason,
    hyperVLinuxSmokeImageResult,
} from "@ccc/device-lab/device-lab/hyper-v-linux-image-readiness.js";

const globalCache: HyperVUbuntuImageCacheInspection = { state: "valid", source: "global" };
const ownerCache: HyperVUbuntuImageCacheInspection = { state: "valid", source: "owner" };
const noCache: HyperVUbuntuImageCacheInspection = { state: "acquisition-required" };
const conflict: HyperVUbuntuImageCacheInspection = { state: "conflict", code: "hyper-v-base-image-artifact-owner-unknown" };

const trusted = { linuxImageMissing: [], qemuImgSignatureStatus: "Valid" as const };
const untrusted = { linuxImageMissing: ["hyper-v-qemu-img-untrusted"], qemuImgSignatureStatus: "NotSigned" as const };
const unavailable = { linuxImageMissing: ["hyper-v-qemu-img-unavailable"] };

describe("Hyper-V linux-vm image readiness", () => {
    it("does not block a validated cached image on qemu-img and reports its state as an advisory", () => {
        expect(hyperVLinuxImageBlockers(untrusted, globalCache)).toEqual({
            blockers: [],
            advisories: ["hyper-v-qemu-img-untrusted"],
            baseImage: { state: "valid", source: "global" },
            imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-untrusted"] },
        });
        expect(hyperVLinuxImageBlockers(unavailable, ownerCache)).toEqual({
            blockers: [],
            advisories: ["hyper-v-qemu-img-unavailable"],
            baseImage: { state: "valid", source: "owner" },
            imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-unavailable"] },
        });
        expect(hyperVLinuxImageBlockers(trusted, globalCache)).toEqual({
            blockers: [],
            advisories: [],
            baseImage: { state: "valid", source: "global" },
            imageAcquisition: { available: true, missing: [] },
        });
    });

    it("blocks on qemu-img only when create would have to acquire the image", () => {
        expect(hyperVLinuxImageBlockers(untrusted, noCache)).toEqual({
            blockers: ["hyper-v-qemu-img-untrusted"],
            advisories: [],
            baseImage: { state: "acquisition-required", source: null },
            imageAcquisition: { available: false, missing: ["hyper-v-qemu-img-untrusted"] },
        });
        expect(hyperVLinuxImageBlockers(trusted, noCache).blockers).toEqual([]);
        // A probe that predates the qemu-img fields keeps the earlier, non-blocking answer.
        expect(hyperVLinuxImageBlockers({}, noCache)).toEqual({
            blockers: [],
            advisories: [],
            baseImage: { state: "acquisition-required", source: null },
            imageAcquisition: { available: true, missing: [] },
        });
    });

    it("blocks a cache conflict with its own code, whatever qemu-img reports", () => {
        for (const readiness of [trusted, untrusted, unavailable]) {
            expect(hyperVLinuxImageBlockers(readiness, conflict)).toEqual(expect.objectContaining({
                blockers: ["hyper-v-base-image-artifact-owner-unknown"],
                advisories: [],
                baseImage: { state: "conflict", source: null },
            }));
        }
    });

    it("leaves acquisition unknown when the readiness probe gave no answer", () => {
        expect(hyperVLinuxImageBlockers(null, globalCache)).toEqual({
            blockers: [],
            advisories: [],
            baseImage: { state: "valid", source: "global" },
            imageAcquisition: null,
        });
        expect(hyperVLinuxImageBlockers(null, noCache).blockers).toEqual([]);
        expect(hyperVLinuxImageBlockers(null, conflict).blockers).toEqual(["hyper-v-base-image-artifact-owner-unknown"]);
    });

    it("does not let callers alias the readiness list through the decision", () => {
        const readiness = { linuxImageMissing: ["hyper-v-qemu-img-untrusted"] };
        const image = hyperVLinuxImageBlockers(readiness, noCache);
        image.blockers.push("changed");
        image.imageAcquisition!.missing.push("changed");
        expect(readiness.linuxImageMissing).toEqual(["hyper-v-qemu-img-untrusted"]);
        expect(image.imageAcquisition!.missing).not.toBe(image.blockers);
    });

    it("names the closed signature status in an untrusted skip reason", () => {
        expect(hyperVLinuxImageSkipReason(untrusted, hyperVLinuxImageBlockers(untrusted, noCache)))
            .toBe("missing hyper-v-qemu-img-untrusted (qemu-img signature NotSigned)");
        expect(hyperVLinuxImageSkipReason(unavailable, hyperVLinuxImageBlockers(unavailable, noCache)))
            .toBe("missing hyper-v-qemu-img-unavailable");
        expect(hyperVLinuxImageSkipReason(untrusted, hyperVLinuxImageBlockers(untrusted, conflict)))
            .toBe("missing hyper-v-base-image-artifact-owner-unknown");
    });

    it("passes the smoke on a cache hit without claiming a trusted qemu-img", () => {
        const untrustedHit = hyperVLinuxSmokeImageResult(untrusted, globalCache);
        expect(untrustedHit).toEqual({
            status: "PASS",
            detail: "Hyper-V, cached ubuntu-lts base image, SSH, and SCP are ready; qemu-img untrusted (signature NotSigned), needed only to re-acquire the image; no VM started",
        });
        expect(untrustedHit.detail).not.toContain("trusted qemu-img");
        expect(hyperVLinuxSmokeImageResult(unavailable, ownerCache)).toEqual({
            status: "PASS",
            detail: "Hyper-V, cached ubuntu-lts base image, SSH, and SCP are ready; qemu-img unavailable, needed only to re-acquire the image; no VM started",
        });
        expect(hyperVLinuxSmokeImageResult(trusted, globalCache)).toEqual({
            status: "PASS",
            detail: "Hyper-V, cached ubuntu-lts base image, SSH, and SCP are ready; no VM started",
        });
    });

    it("keeps the smoke answer for a host that must acquire the image", () => {
        expect(hyperVLinuxSmokeImageResult(trusted, noCache)).toEqual({
            status: "PASS",
            detail: "Hyper-V, trusted qemu-img, SSH, and SCP are ready; no VM started",
        });
        expect(hyperVLinuxSmokeImageResult(untrusted, noCache)).toEqual({
            status: "SKIP",
            detail: "missing hyper-v-qemu-img-untrusted (qemu-img signature NotSigned)",
        });
        expect(hyperVLinuxSmokeImageResult(unavailable, noCache)).toEqual({
            status: "SKIP",
            detail: "missing hyper-v-qemu-img-unavailable",
        });
    });

    it("skips the smoke on a cache conflict with the conflict code, even when qemu-img is trusted", () => {
        expect(hyperVLinuxSmokeImageResult(trusted, conflict)).toEqual({
            status: "SKIP",
            detail: "missing hyper-v-base-image-artifact-owner-unknown",
        });
        expect(hyperVLinuxSmokeImageResult(untrusted, { state: "conflict", code: "hyper-v-base-image-profile-conflict" })).toEqual({
            status: "SKIP",
            detail: "missing hyper-v-base-image-profile-conflict",
        });
    });
});
