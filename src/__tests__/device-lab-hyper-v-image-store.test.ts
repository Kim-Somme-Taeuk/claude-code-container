import { createHash } from "crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import {
    cleanupIncompleteHyperVImageArtifacts,
    hyperVImageProfile,
    hyperVImageProfileRoot,
    hyperVImageRoot,
    hyperVOwnerImageProfileRoot,
    readHyperVImageManifestMetadata,
    resolveHyperVImageForCreate,
    type HyperVImageCommandResult,
    type HyperVImageStoreRuntime,
} from "../device-lab/broker/hyper-v/image-store.js";
import { HYPER_V_IMAGE_CATALOG } from "../device-lab/hyper-v-images.js";
import { HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP, type HyperVWindowsExecutionRequest } from "../hyper-v-windows/index.js";

function automaticUbuntuStep(
    command: Parameters<HyperVImageStoreRuntime["run"]>[0],
    profileRoot: string,
    image: Buffer,
    onPrepare?: () => void,
    finalizeOverrides: Record<string, unknown> = {},
): HyperVImageCommandResult {
    const imagePath = join(profileRoot, "base.vhdx");
    const partialPath = join(profileRoot, "base.partial.vhdx");
    const sourceVhdPath = join(profileRoot, ".acquire-work", "converted.normalized.fixed.vhd");
    const success = (operation: HyperVWindowsExecutionRequest["operation"], items: readonly unknown[] = []) => ({
        ...command, status: 0, stderr: "",
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
    });
    if (command.args.at(-1) === HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP) {
        const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
        const request = JSON.parse(envelope.input) as HyperVWindowsExecutionRequest;
        if (request.operation === "Convert-VHD") {
            expect(request).toMatchObject({ sourcePath: sourceVhdPath, destinationPath: partialPath, vhdType: "Dynamic" });
            writeFileSync(partialPath, image);
            return success(request.operation);
        }
        if (request.operation === "Resize-VHD") return success(request.operation);
        if (request.operation === "Get-VHD") {
            const file = readFileSync(request.path);
            return success(request.operation, [{
                path: request.path,
                vhdFormat: request.path === sourceVhdPath ? "VHD" : "VHDX",
                vhdType: request.path === sourceVhdPath ? "Fixed" : "Dynamic",
                parentPath: null,
                virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                fileSizeBytes: file.length,
            }]);
        }
        throw new Error(`unexpected typed image operation: ${request.operation}`);
    }
    const script = Buffer.from(command.input || "", "base64").toString("utf8");
    const marker = (observation: unknown) => `CCC_HYPER_V_RESULT_B64:${Buffer.from(JSON.stringify(observation)).toString("base64")}`;
    if (script.includes("function Save-BoundedDownload")) {
        onPrepare?.();
        mkdirSync(dirname(sourceVhdPath), { recursive: true });
        writeFileSync(sourceVhdPath, image);
        writeFileSync(join(profileRoot, "source.qcow2"), "verified-source");
        return {
            ...command, status: 0, stderr: "",
            stdout: marker({ ok: true, profile: "ubuntu-lts", imagePath, partialPath, sourceVhdPath,
                sourceVhdSha256: createHash("sha256").update(image).digest("hex"),
                sourceVirtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                qemuSha256: "a".repeat(64) }),
        };
    }
    if (script.includes("$ExpectedPartialHash =")) {
        writeFileSync(imagePath, readFileSync(partialPath));
        return {
            ...command, status: 0, stderr: "",
            stdout: marker({ ok: true, profile: "ubuntu-lts", imagePath,
                sha256: createHash("sha256").update(image).digest("hex"), sizeBytes: image.length,
                virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
                vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false,
                ...finalizeOverrides }),
        };
    }
    throw new Error("unexpected automatic image command");
}

describe("Hyper-V image store module", () => {
    it("uses Canonical's generic bootable QCOW2 source instead of its Azure-only VHD", () => {
        const ubuntu = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];

        expect(ubuntu.sourceUrl).toContain("cloud-images.ubuntu.com/releases/noble/release-20260725/");
        expect(ubuntu.sourceUrl).toMatch(/server-cloudimg-amd64\.img$/);
        expect(ubuntu.sourceUrl).not.toContain("-azure.");
        expect(ubuntu.sourceUrl).not.toContain("ubuntu-desktop-hyperv");
        expect(ubuntu.sourceFormat).toBe("qcow2");
        expect(ubuntu.sourceSha256).toBe("d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac");
        expect(ubuntu.virtualSizeBytes).toBe(32 * 1024 * 1024 * 1024);
        expect(ubuntu.generation).toBe(2);
    });

    it("keeps image cache paths below the injected private root", () => {
        const privateRoot = "/private/device-broker";

        expect(hyperVImageRoot(privateRoot)).toBe("/private/device-broker/images/hyper-v");
        expect(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"))
            .toBe("/private/device-broker/images/hyper-v/ubuntu-lts");
        expect(hyperVOwnerImageProfileRoot(privateRoot, "owner-a", "windows-11"))
            .toBe("/private/device-broker/owners/owner-a/images/hyper-v/windows-11");
    });

    it("accepts only supported image profiles", () => {
        expect(hyperVImageProfile("windows-11")).toBe("windows-11");
        expect(hyperVImageProfile("windows-server")).toBe("windows-server");
        expect(hyperVImageProfile("ubuntu-lts")).toBe("ubuntu-lts");
        expect(hyperVImageProfile("custom")).toBeNull();
    });

    it("does not import the broker facade", () => {
        const source = readFileSync(
            new URL("../device-lab/broker/hyper-v/image-store.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toContain("device-lab-broker");
    });

    it("preserves a regular retry-cache candidate for checksum verification on the next attempt", () => {
        const profileRoot = join(tmpdir(), `ccc-hyper-v-image-cleanup-${process.pid}-${Date.now()}`);
        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
        writeFileSync(join(profileRoot, "source.qcow2"), "verified-source");
        writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial-image");

        try {
            cleanupIncompleteHyperVImageArtifacts(profileRoot);

            expect(readFileSync(join(profileRoot, "source.qcow2"), "utf8")).toBe("verified-source");
            expect(existsSync(join(profileRoot, "base.partial.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
        } finally {
            rmSync(profileRoot, { recursive: true, force: true });
        }
    });

    it("removes legacy Azure VHD caches while preserving the current QCOW2 source", () => {
        const profileRoot = join(tmpdir(), `ccc-hyper-v-image-cache-migration-${process.pid}-${Date.now()}`);
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(join(profileRoot, "source.vmdk"), "legacy-source");
        writeFileSync(join(profileRoot, "source.vhd.tar.gz"), "legacy-azure-vhd");
        writeFileSync(join(profileRoot, "source.qcow2"), "current-source");

        try {
            cleanupIncompleteHyperVImageArtifacts(profileRoot);

            expect(existsSync(join(profileRoot, "source.vmdk"))).toBe(false);
            expect(existsSync(join(profileRoot, "source.vhd.tar.gz"))).toBe(false);
            expect(readFileSync(join(profileRoot, "source.qcow2"), "utf8")).toBe("current-source");
        } finally {
            rmSync(profileRoot, { recursive: true, force: true });
        }
    });

    const invalidCacheKinds = process.platform === "win32"
        ? (["directory", "hardlink", "empty", "oversized"] as const)
        : (["directory", "symlink", "hardlink", "empty", "oversized"] as const);

    it.each(invalidCacheKinds)(
        "removes an invalid %s retry cache during failure cleanup",
        (kind) => {
            const root = join(tmpdir(), `ccc-hyper-v-invalid-cache-${kind}-${process.pid}-${Date.now()}`);
            const profileRoot = join(root, "profile");
            const sourceArchivePath = join(profileRoot, "source.qcow2");
            mkdirSync(profileRoot, { recursive: true });

            try {
                if (kind === "directory") {
                    mkdirSync(sourceArchivePath);
                    writeFileSync(join(sourceArchivePath, "unexpected"), "content");
                } else if (kind === "symlink") {
                    const target = join(root, "outside.zip");
                    writeFileSync(target, "outside");
                    symlinkSync(target, sourceArchivePath);
                } else if (kind === "hardlink") {
                    const target = join(profileRoot, "other.zip");
                    writeFileSync(target, "linked");
                    linkSync(target, sourceArchivePath);
                } else if (kind === "oversized") {
                    writeFileSync(sourceArchivePath, "oversized");
                    truncateSync(sourceArchivePath, (6 * 1024 * 1024 * 1024) + 1);
                } else {
                    writeFileSync(sourceArchivePath, "");
                }

                cleanupIncompleteHyperVImageArtifacts(profileRoot);

                expect(existsSync(sourceArchivePath)).toBe(false);
                if (kind === "symlink") {
                    expect(readFileSync(join(root, "outside.zip"), "utf8")).toBe("outside");
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it("retains the bounded cloud image and removes owned work after committing an automatic image manifest", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-image-success-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const sourceArchivePath = join(profileRoot, "source.qcow2");
        const image = Buffer.from("automatic-hyper-v-image");
        const sha256 = createHash("sha256").update(image).digest("hex");
        mkdirSync(profileRoot, { recursive: true });

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, image),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
            const manifestText = readFileSync(join(profileRoot, "manifest.json"), "utf8");
            expect(manifestText).toContain(sha256);
            expect(manifestText).toContain(HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256);
            expect(readFileSync(sourceArchivePath, "utf8")).toBe("verified-source");
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("does not retry obsolete EFI mutation failures through elevation", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-image-elevated-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const sourceArchivePath = join(profileRoot, "source.qcow2");
        const commands: Array<{ executable?: string }> = [];

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "provider-powershell.exe",
                    run: async (providerCommand) => {
                        commands.push(providerCommand);
                        mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                        writeFileSync(join(profileRoot, ".acquire-work", "converted.qemu.fixed.vhd"), "temporary");
                        writeFileSync(sourceArchivePath, "verified-source");
                        return {
                            mode: "exec",
                            provider: "hyper-v",
                            status: 1,
                            stdout: "",
                            stderr: "hyper-v-base-image-efi-fallback-failed",
                        };
                    },
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-base-image-prepare-failed",
            }));
            expect(commands).toHaveLength(1);
            expect(commands[0].executable).toBe("provider-powershell.exe");
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
            expect(readdirSync(profileRoot).some((name) => name.startsWith(".work-uncertain-"))).toBe(true);
            expect(readFileSync(sourceArchivePath, "utf8")).toBe("verified-source");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic image manifest whose generation differs from the catalog", () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-generation-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, "automatic-hyper-v-image");
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: catalog.licenseId,
            generation: 1,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: "a".repeat(64),
            sizeBytes: 23,
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(() => readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts"))
                .toThrow("hyper-v-base-image-manifest-provenance-mismatch");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic image manifest produced from a different catalog source checksum", () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-checksum-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        const image = Buffer.from("automatic-hyper-v-image");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, image);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: "f".repeat(64),
            licenseId: catalog.licenseId,
            generation: catalog.generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(image).digest("hex"),
            sizeBytes: image.length,
            virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(() => readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts"))
                .toThrow("hyper-v-base-image-manifest-provenance-mismatch");
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("reacquires the immediately previous Ubuntu catalog after adding native content verification", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-old-finalization-manifest-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        const image = Buffer.from("pre-native-finalization-image");
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, image);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1",
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: catalog.licenseId,
            generation: catalog.generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(image).digest("hex"),
            sizeBytes: image.length,
            virtualSizeBytes: catalog.virtualSizeBytes,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));

        try {
            expect(catalog.catalogId).toBe("canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v2");
            let acquisitions = 0;
            const replacement = Buffer.from("content-verified-native-vhdx");
            const replacementSha256 = createHash("sha256").update(replacement).digest("hex");
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, replacement, () => {
                        acquisitions += 1;
                        expect(existsSync(imagePath)).toBe(false);
                        expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
                    }),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );
            expect(acquisitions).toBe(1);
            expect(result).toEqual(expect.objectContaining({ ok: true, prepared: true }));
            expect(readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts")).toEqual(expect.objectContaining({
                catalogId: catalog.catalogId,
                sha256: replacementSha256,
            }));
            expect(existsSync(join(profileRoot, ".base-prior-recovery.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".manifest-prior-recovery.json"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });

    it("rejects an automatic provider observation whose generation differs from the catalog", async () => {
        const privateRoot = join(tmpdir(), `ccc-hyper-v-generation-observation-${process.pid}-${Date.now()}`);
        const profileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const image = Buffer.from("automatic-hyper-v-image");

        try {
            const result = await resolveHyperVImageForCreate(
                "0123456789abcdef",
                { backend: "linux-vm", dryRun: false, create: { profile: "ubuntu-lts" } },
                {},
                {
                    cwd: privateRoot,
                    privateRoot,
                    resolveExecutable: () => "powershell.exe",
                    run: async (command) => automaticUbuntuStep(command, profileRoot, image, undefined, { generation: 1 }),
                    limits: {
                        acquireTimeoutMs: 60_000,
                        prepareTimeoutMs: 60_000,
                        lockWaitMs: 60_000,
                        commandOutputBytes: 64 * 1024,
                    },
                },
            );

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "hyper-v-base-image-prepare-failed",
                detail: "hyper-v-base-image-acquire-invalid-result",
            }));
            expect(readFileSync(imagePath)).toEqual(image);
            expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
        } finally {
            rmSync(privateRoot, { recursive: true, force: true });
        }
    });
});
