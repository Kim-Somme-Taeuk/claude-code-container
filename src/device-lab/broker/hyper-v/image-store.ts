import { createHash, randomBytes } from "crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "fs";
import { promises as fsPromises } from "fs";
import { dirname, join, resolve, win32 } from "path";
import { assertDeviceLabPathWithinRoot, readDeviceLabStateFile } from "../../../device-lab-state-file.js";
import { withSharedMutationLockAsync, writeJsonFileAtomically } from "../../../device-lab-shared-state.js";
import { quarantineAndRemoveDirectory } from "../../../device-lab-safe-cleanup.js";
import { HYPER_V_IMAGE_CATALOG, readHyperVWindowsEvaluationReceipt } from "../../hyper-v-images.js";
import {
    assertHyperVOperationDeadline,
    HyperVOperationDeadlineError,
    hyperVOperationDeadlineExpired,
    hyperVRemainingTimeout,
} from "./deadline.js";
import {
    hyperVBoundedErrorCode,
    hyperVBoundedErrorDetail,
    hyperVProviderDiagnosticCode,
} from "./public-response.js";
import {
    hyperVAcquireBaseImagePrepareCommand,
    hyperVAcquireBaseImageFinalizeCommand,
    hyperVImportedImageStorageCommand,
    parseHyperVAcquireBaseImagePrepareObservation,
    parseHyperVBaseImageObservation,
    parseHyperVImportedImageStorage,
    type HyperVBaseImageObservation,
    type HyperVProviderCommand,
} from "../../../host-control/hyper-v/index.js";
import { createDeviceLabHyperVWindowsClient } from "./lifecycle-adapter.js";
import { inspectHyperVCreateVhd } from "./vhd-create-inspection.js";
import type { HyperVVirtualHardDisk } from "../../../hyper-v-windows/index.js";

const HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES = 16 * 1024;
const HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES = 64 * 1024 * 1024 * 1024;
const HYPER_V_AUTOMATIC_SOURCE_CACHE_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
const HYPER_V_IMAGE_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const HYPER_V_PRIOR_UBUNTU_CATALOG_ID = "canonical-ubuntu-24.04-lts-server-cloudimg-qcow2-native-vhdx-20260725-v1";
const HYPER_V_IMAGE_OWNER_ID_PATTERN = /^[a-f0-9]{16}$/;

export type HyperVImageProfile = "windows-11" | "windows-server" | "ubuntu-lts";

export type HyperVImageManifest = {
    version: 3;
    profile: HyperVImageProfile;
    catalogId: string;
    sourceUrl: string | null;
    sourceFormat: "vhdx" | "vhd-tar-gz" | "vhdx-zip" | "qcow2" | "vmdk";
    sourceSha256: string | null;
    licenseId: string | null;
    generation: 1 | 2;
    secureBootTemplate: "MicrosoftWindows" | "MicrosoftUEFICertificateAuthority";
    preparationVersion: 1;
    imagePath: string;
    sha256: string;
    sizeBytes: number;
    virtualSizeBytes: number;
    vhdType: string;
    preparedAt: string;
};

export type HyperVImageResolution =
    | { ok: true; params: Record<string, unknown>; imagePath: string; prepared: boolean }
    | { ok: false; status: number; error: string; detail?: string; remedy?: string };

export type HyperVImageCommandResult = {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
};

export interface HyperVImageStoreRuntime {
    cwd: string;
    privateRoot: string;
    resolveExecutable(name: string): string | null;
    run(
        command: HyperVProviderCommand,
        options: { timeoutMs: number; outputLimit: number },
    ): Promise<HyperVImageCommandResult>;
    limits: {
        acquireTimeoutMs: number;
        prepareTimeoutMs: number;
        lockWaitMs: number;
        commandOutputBytes: number;
    };
}

export type HyperVImageCreateRequest = {
    backend: string;
    dryRun: boolean;
    create?: Record<string, unknown>;
};

export type HyperVUbuntuImageCacheConflictCode =
    | "hyper-v-base-image-profile-conflict"
    | "hyper-v-base-image-unmanaged-existing"
    | "hyper-v-base-image-artifact-owner-unknown";

export type HyperVUbuntuImageCacheInspection =
    | { state: "valid"; source: "owner" | "global"; code?: undefined }
    | { state: "acquisition-required"; source?: undefined; code?: undefined }
    | { state: "conflict"; source?: undefined; code: HyperVUbuntuImageCacheConflictCode };

export function hyperVImageProfile(value: unknown): HyperVImageProfile | null {
    return value === "windows-11" || value === "windows-server" || value === "ubuntu-lts" ? value : null;
}

export function hyperVImageRoot(privateRoot: string): string {
    return join(privateRoot, "images", "hyper-v");
}

export function hyperVImageProfileRoot(privateRoot: string, profile: HyperVImageProfile): string {
    return join(hyperVImageRoot(privateRoot), profile);
}

export function hyperVOwnerImageProfileRoot(privateRoot: string, ownerId: string, profile: HyperVImageProfile): string {
    return join(privateRoot, "owners", ownerId, "images", "hyper-v", profile);
}

export function cleanupIncompleteHyperVImageArtifacts(profileRoot: string): void {
    assertNoSymlinkPathComponents(profileRoot, "hyper-v-base-image-cleanup");
    rmSync(join(profileRoot, "base.partial.vhdx"), { force: true });
    const acquireWork = join(profileRoot, ".acquire-work");
    if (existsSync(acquireWork)) {
        quarantineAndRemoveDirectory(acquireWork, (path) => {
            assertDeviceLabPathWithinRoot(profileRoot, path, "hyper-v-base-image-cleanup");
            assertNoSymlinkPathComponents(path, "hyper-v-base-image-cleanup");
        });
    }
    for (const sourceCache of [join(profileRoot, "source.vmdk"), join(profileRoot, "source.vhdx.zip"), join(profileRoot, "source.vhd.tar.gz"), join(profileRoot, "source.qcow2")]) {
        try {
            const archiveMetadata = lstatSync(sourceCache);
            const currentCache = sourceCache.endsWith("source.qcow2");
            const validRetryCache = currentCache
                && archiveMetadata.isFile()
                && !archiveMetadata.isSymbolicLink()
                && archiveMetadata.nlink === 1
                && archiveMetadata.size > 0
                && archiveMetadata.size <= HYPER_V_AUTOMATIC_SOURCE_CACHE_LIMIT_BYTES;
            if (!validRetryCache) {
                if (archiveMetadata.isDirectory() && !archiveMetadata.isSymbolicLink()) {
                    quarantineAndRemoveDirectory(sourceCache, (path) => {
                        assertDeviceLabPathWithinRoot(profileRoot, path, "hyper-v-base-image-cache-cleanup");
                        assertNoSymlinkPathComponents(path, "hyper-v-base-image-cache-cleanup");
                    });
                } else {
                    rmSync(sourceCache, { force: true });
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
    }
}

type AutomaticArtifactIdentity = { dev: bigint; ino: bigint; directory: boolean };

function automaticArtifactIdentity(path: string): AutomaticArtifactIdentity | null {
    try {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink()) throw new Error("hyper-v-base-image-artifact-symlink");
        return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
    }
}

function assertAutomaticFileIdentity(path: string, expected: AutomaticArtifactIdentity, label: string): void {
    const current = automaticArtifactIdentity(path);
    if (!current || current.directory || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error(`${label}-identity-changed`);
    }
}

function cleanupOwnedAutomaticArtifacts(profileRoot: string, owned: Map<string, AutomaticArtifactIdentity>): void {
    for (const path of [join(profileRoot, "base.partial.vhdx"), join(profileRoot, ".acquire-work")]) {
        const expected = owned.get(path);
        if (!expected) continue;
        const current = automaticArtifactIdentity(path);
        if (!current || current.dev !== expected.dev || current.ino !== expected.ino || current.directory !== expected.directory) continue;
        if (current.directory) {
            quarantineAndRemoveDirectory(path, (candidate) => {
                assertDeviceLabPathWithinRoot(profileRoot, candidate, "hyper-v-base-image-cleanup");
                assertNoSymlinkPathComponents(candidate, "hyper-v-base-image-cleanup");
            });
        } else {
            rmSync(path);
        }
    }
}

function quarantineUncertainAutomaticArtifact(profileRoot: string, path: string, label: string): boolean {
    const identity = automaticArtifactIdentity(path);
    if (!identity) return false;
    assertNoSymlinkPathComponents(path, label);
    assertDeviceLabPathWithinRoot(profileRoot, path, label);
    const quarantine = join(profileRoot, `.${label}-${randomBytes(12).toString("hex")}.retained`);
    renameSync(path, quarantine);
    const moved = automaticArtifactIdentity(quarantine);
    if (!moved || moved.dev !== identity.dev || moved.ino !== identity.ino || moved.directory !== identity.directory) {
        if (!existsSync(path)) renameSync(quarantine, path);
        throw new Error("hyper-v-base-image-artifact-identity-changed");
    }
    return true;
}

// The exact manifest of the immediately previous automatic ubuntu-lts catalog, or null. Throws when
// the file cannot be read; callers treat that as not the prior catalog.
function readKnownPriorAutomaticManifest(profileRoot: string, manifestPath: string): { sha256: string; sizeBytes: number } | null {
    const raw = readDeviceLabStateFile(manifestPath, (value) => value, "hyper-v-base-image-prior-manifest", HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const prior = raw as Record<string, unknown>;
    const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
    if (prior.version !== 3 || prior.profile !== "ubuntu-lts"
        || prior.catalogId !== HYPER_V_PRIOR_UBUNTU_CATALOG_ID
        || prior.sourceUrl !== catalog.sourceUrl || prior.sourceSha256 !== catalog.sourceSha256
        || prior.sourceFormat !== catalog.sourceFormat || prior.generation !== catalog.generation
        || prior.licenseId !== catalog.licenseId || prior.secureBootTemplate !== catalog.secureBootTemplate
        || prior.preparationVersion !== 1 || prior.imagePath !== join(profileRoot, "base.vhdx")
        || typeof prior.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(prior.sha256)
        || typeof prior.sizeBytes !== "number" || !Number.isSafeInteger(prior.sizeBytes) || prior.sizeBytes <= 0
        || prior.virtualSizeBytes !== catalog.virtualSizeBytes || prior.vhdType !== "Dynamic"
        || typeof prior.preparedAt !== "string" || !Number.isFinite(Date.parse(prior.preparedAt))) return null;
    return { sha256: prior.sha256, sizeBytes: prior.sizeBytes };
}

async function isKnownPriorAutomaticImage(
    profile: "windows-server" | "ubuntu-lts",
    profileRoot: string,
    deadlineAt: number,
    manifestPath = join(profileRoot, "manifest.json"),
    imageFile = join(profileRoot, "base.vhdx"),
): Promise<{ manifestBytes: Buffer; imageSha256: string; imageSize: number } | null> {
    if (profile !== "ubuntu-lts") return null;
    try {
        const prior = readKnownPriorAutomaticManifest(profileRoot, manifestPath);
        if (!prior) return null;
        const image = inspectLargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior");
        if (image.size !== prior.sizeBytes
            || await sha256LargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior", deadlineAt) !== prior.sha256) return null;
        return { manifestBytes: readFileSync(manifestPath), imageSha256: prior.sha256, imageSize: image.size };
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        return null;
    }
}

function priorRecoveryPaths(profileRoot: string): { manifest: string; image: string } {
    return {
        manifest: join(profileRoot, ".manifest-prior-recovery.json"),
        image: join(profileRoot, ".base-prior-recovery.vhdx"),
    };
}

async function recoverPriorAutomaticImage(profileRoot: string, deadlineAt: number): Promise<void> {
    const backup = priorRecoveryPaths(profileRoot);
    if (!existsSync(backup.manifest) && !existsSync(backup.image)) return;
    const manifestPath = join(profileRoot, "manifest.json");
    const imagePath = join(profileRoot, "base.vhdx");
    // A completed new pair can use the normal cache path. Keep the old pair until
    // a guarded maintenance pass can validate it again.
    if (existsSync(manifestPath) && existsSync(imagePath)) return;
    const manifestFile = existsSync(backup.manifest) ? backup.manifest : manifestPath;
    const imageFile = existsSync(backup.image) ? backup.image : imagePath;
    const prior = await isKnownPriorAutomaticImage("ubuntu-lts", profileRoot, deadlineAt, manifestFile, imageFile);
    if (!prior || (manifestFile !== backup.manifest && existsSync(backup.manifest))
        || (imageFile !== backup.image && existsSync(backup.image))
        || (manifestFile === backup.manifest && existsSync(manifestPath))
        || (imageFile === backup.image && existsSync(imagePath) && existsSync(manifestPath))) {
        throw new Error("hyper-v-base-image-profile-conflict");
    }
    if (imageFile === backup.image && existsSync(imagePath)) {
        quarantineUncertainAutomaticArtifact(profileRoot, imagePath, "base-uncertain");
    }
    if (imageFile === backup.image) renameSync(backup.image, imagePath);
    if (manifestFile === backup.manifest) renameSync(backup.manifest, manifestPath);
}

async function retireKnownPriorAutomaticImage(profileRoot: string, prior: {
    manifestBytes: Buffer; imageSha256: string; imageSize: number;
}, deadlineAt: number): Promise<{ manifest: AutomaticArtifactIdentity; image: AutomaticArtifactIdentity }> {
    const manifestPath = join(profileRoot, "manifest.json");
    const imagePath = join(profileRoot, "base.vhdx");
    const { manifest: retiredManifest, image: retiredImage } = priorRecoveryPaths(profileRoot);
    if (existsSync(retiredManifest) || existsSync(retiredImage)) throw new Error("hyper-v-base-image-profile-conflict");
    let manifestMoved = false;
    let imageMoved = false;
    try {
        renameSync(manifestPath, retiredManifest);
        manifestMoved = true;
        if (!readFileSync(retiredManifest).equals(prior.manifestBytes)) throw new Error("hyper-v-base-image-prior-changed");
        renameSync(imagePath, retiredImage);
        imageMoved = true;
        const retired = inspectLargeRegularFile(profileRoot, retiredImage, "hyper-v-base-image-prior");
        if (retired.size !== prior.imageSize
            || await sha256LargeRegularFile(profileRoot, retiredImage, "hyper-v-base-image-prior", deadlineAt) !== prior.imageSha256) {
            throw new Error("hyper-v-base-image-prior-changed");
        }
        // Keep the validated pair recoverable until the replacement manifest commits.
        const manifestIdentity = automaticArtifactIdentity(retiredManifest);
        const imageIdentity = automaticArtifactIdentity(retiredImage);
        if (!manifestIdentity || !imageIdentity) throw new Error("hyper-v-base-image-prior-changed");
        return { manifest: manifestIdentity, image: imageIdentity };
    } catch (error) {
        if (imageMoved && !existsSync(imagePath)) renameSync(retiredImage, imagePath);
        if (manifestMoved && !existsSync(manifestPath)) renameSync(retiredManifest, manifestPath);
        throw error;
    }
}

async function discardRetiredPriorAutomaticImage(
    profileRoot: string,
    prior: { manifestBytes: Buffer; imageSha256: string; imageSize: number },
    identities: { manifest: AutomaticArtifactIdentity; image: AutomaticArtifactIdentity },
    deadlineAt: number,
): Promise<void> {
    const backup = priorRecoveryPaths(profileRoot);
    const checked = await isKnownPriorAutomaticImage("ubuntu-lts", profileRoot, deadlineAt, backup.manifest, backup.image);
    if (!checked || !checked.manifestBytes.equals(prior.manifestBytes)
        || checked.imageSha256 !== prior.imageSha256 || checked.imageSize !== prior.imageSize) return;
    const manifestIdentity = automaticArtifactIdentity(backup.manifest);
    const imageIdentity = automaticArtifactIdentity(backup.image);
    if (!manifestIdentity || !imageIdentity
        || manifestIdentity.dev !== identities.manifest.dev || manifestIdentity.ino !== identities.manifest.ino
        || imageIdentity.dev !== identities.image.dev || imageIdentity.ino !== identities.image.ino) return;
    rmSync(backup.image);
    rmSync(backup.manifest);
}

export function assertNoSymlinkPathComponents(file: string, label: string): void {
    const chain: string[] = [];
    let current = resolve(file);
    while (true) {
        chain.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    for (const component of chain.reverse()) {
        try {
            if (lstatSync(component).isSymbolicLink()) throw new Error(`${label}-path-symlink-rejected`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
            throw error;
        }
    }
}

export function inspectLargeRegularFile(root: string, file: string, label: string): { path: string; size: number } {
    const absolute = resolve(file);
    assertNoSymlinkPathComponents(root, label);
    assertNoSymlinkPathComponents(absolute, label);
    assertDeviceLabPathWithinRoot(root, absolute, label);
    const pathStat = lstatSync(absolute);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    try {
        const descriptorStat = fstatSync(descriptor);
        if (!descriptorStat.isFile() || descriptorStat.nlink !== 1
            || descriptorStat.dev !== pathStat.dev
            || descriptorStat.ino !== pathStat.ino
            || descriptorStat.size !== pathStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return { path: absolute, size: descriptorStat.size };
    } finally {
        closeSync(descriptor);
    }
}

export async function stageLargeRegularFileFromProject(
    root: string,
    file: string,
    targetRoot: string,
    label: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<string> {
    const absolute = resolve(file);
    if (dirname(absolute) !== resolve(root)) throw new Error(`${label}-must-be-project-root-file`);
    const stagingPath = join(targetRoot, `.source-${randomBytes(12).toString("hex")}.vhdx`);
    let sourceDescriptor: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    let targetDescriptor: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
    try {
        assertNoSymlinkPathComponents(root, label);
        assertNoSymlinkPathComponents(absolute, label);
        assertDeviceLabPathWithinRoot(root, absolute, label);
        const pathStat = await fsPromises.lstat(absolute);
        if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0 || pathStat.size > HYPER_V_IMPORTED_IMAGE_LIMIT_BYTES) {
            throw new Error(`${label}-invalid`);
        }
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        sourceDescriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow);
        const openedSource = await sourceDescriptor.stat();
        const currentSource = await fsPromises.lstat(absolute);
        if (!openedSource.isFile() || openedSource.nlink !== 1
            || openedSource.dev !== pathStat.dev || openedSource.ino !== pathStat.ino || openedSource.size !== pathStat.size
            || currentSource.isSymbolicLink() || currentSource.nlink !== 1 || currentSource.dev !== openedSource.dev || currentSource.ino !== openedSource.ino || currentSource.size !== openedSource.size) {
            throw new Error(`${label}-identity-changed`);
        }
        await fsPromises.mkdir(targetRoot, { recursive: true, mode: 0o700 });
        assertNoSymlinkPathComponents(targetRoot, `${label}-staging`);
        assertDeviceLabPathWithinRoot(targetRoot, stagingPath, `${label}-staging`);
        targetDescriptor = await fsPromises.open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
        const openedTarget = await targetDescriptor.stat();
        const targetPathStat = await fsPromises.lstat(stagingPath);
        if (!openedTarget.isFile() || openedTarget.nlink !== 1
            || targetPathStat.isSymbolicLink() || targetPathStat.dev !== openedTarget.dev || targetPathStat.ino !== openedTarget.ino) {
            throw new Error(`${label}-staging-identity-changed`);
        }
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let copied = 0;
        while (copied < openedSource.size) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead: count } = await sourceDescriptor.read(buffer, 0, Math.min(buffer.length, openedSource.size - copied), null);
            if (count <= 0) throw new Error(`${label}-copy-short-read`);
            let offset = 0;
            while (offset < count) {
                const { bytesWritten: written } = await targetDescriptor.write(buffer, offset, count - offset, null);
                if (written <= 0) throw new Error(`${label}-copy-short-write`);
                offset += written;
            }
            copied += count;
        }
        await targetDescriptor.sync();
        const finalSource = await sourceDescriptor.stat();
        const finalTarget = await targetDescriptor.stat();
        const finalSourcePath = await fsPromises.lstat(absolute);
        if (finalSource.nlink !== 1 || finalSource.dev !== openedSource.dev || finalSource.ino !== openedSource.ino || finalSource.size !== openedSource.size
            || finalSourcePath.isSymbolicLink() || finalSourcePath.nlink !== 1 || finalSourcePath.dev !== openedSource.dev || finalSourcePath.ino !== openedSource.ino || finalSourcePath.size !== openedSource.size
            || finalTarget.dev !== openedTarget.dev || finalTarget.ino !== openedTarget.ino || finalTarget.size !== openedSource.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return stagingPath;
    } catch (error) {
        if (targetDescriptor !== null) { await targetDescriptor.close(); targetDescriptor = null; }
        if (sourceDescriptor !== null) { await sourceDescriptor.close(); sourceDescriptor = null; }
        try { await fsPromises.unlink(stagingPath); } catch { /* preserve the original failure */ }
        throw error;
    } finally {
        if (targetDescriptor !== null) await targetDescriptor.close();
        if (sourceDescriptor !== null) await sourceDescriptor.close();
    }
}

export async function sha256LargeRegularFile(
    root: string,
    file: string,
    label: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<string> {
    const absolute = resolve(file);
    assertNoSymlinkPathComponents(root, label);
    assertNoSymlinkPathComponents(absolute, label);
    assertDeviceLabPathWithinRoot(root, absolute, label);
    const pathStat = await fsPromises.lstat(absolute);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || pathStat.size <= 0) throw new Error(`${label}-invalid`);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const descriptor = await fsPromises.open(absolute, fsConstants.O_RDONLY | noFollow);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        const openedStat = await descriptor.stat();
        if (!openedStat.isFile() || openedStat.nlink !== 1
            || openedStat.dev !== pathStat.dev
            || openedStat.ino !== pathStat.ino
            || openedStat.size !== pathStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        while (true) {
            assertHyperVOperationDeadline(deadlineAt);
            const { bytesRead: count } = await descriptor.read(buffer, 0, buffer.length, null);
            if (count === 0) break;
            hash.update(buffer.subarray(0, count));
        }
        const finalStat = await descriptor.stat();
        const finalPathStat = await fsPromises.lstat(absolute);
        if (!finalStat.isFile()
            || !finalPathStat.isFile()
            || finalPathStat.isSymbolicLink()
            || finalStat.nlink !== 1
            || finalPathStat.nlink !== 1
            || finalStat.dev !== openedStat.dev
            || finalStat.ino !== openedStat.ino
            || finalStat.size !== openedStat.size
            || finalPathStat.dev !== openedStat.dev
            || finalPathStat.ino !== openedStat.ino
            || finalPathStat.size !== openedStat.size) {
            throw new Error(`${label}-identity-changed`);
        }
        return hash.digest("hex");
    } finally {
        await descriptor.close();
    }
}

function hyperVImageManifest(
    profile: HyperVImageProfile,
    imagePath: string,
    observation: NonNullable<ReturnType<typeof parseHyperVBaseImageObservation>>,
    automatic: boolean,
): HyperVImageManifest {
    const catalog = profile === "windows-server" || profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG[profile] : null;
    return {
        version: 3,
        profile,
        catalogId: automatic && catalog ? catalog.catalogId : "user-provided-vhdx",
        sourceUrl: automatic && catalog ? catalog.sourceUrl : null,
        sourceFormat: automatic && catalog ? catalog.sourceFormat : "vhdx",
        sourceSha256: automatic && catalog && "sourceSha256" in catalog ? catalog.sourceSha256 : null,
        licenseId: automatic && catalog ? catalog.licenseId : null,
        generation: observation.generation,
        secureBootTemplate: profile === "ubuntu-lts" ? "MicrosoftUEFICertificateAuthority" : "MicrosoftWindows",
        preparationVersion: 1,
        imagePath,
        sha256: observation.sha256,
        sizeBytes: observation.sizeBytes,
        virtualSizeBytes: observation.virtualSizeBytes,
        vhdType: observation.vhdType,
        preparedAt: new Date().toISOString(),
    };
}

export function readHyperVImageManifestMetadata(
    privateRoot: string,
    profile: HyperVImageProfile,
    profileRoot = hyperVImageProfileRoot(privateRoot, profile),
    allowUserProvided = false,
): HyperVImageManifest {
    const expectedImagePath = join(profileRoot, "base.vhdx");
    const manifest = readDeviceLabStateFile(join(profileRoot, "manifest.json"), (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hyper-v-base-image-manifest-invalid");
        const value = parsed as Record<string, unknown>;
        if (value.version !== 3
            || value.profile !== profile
            || typeof value.catalogId !== "string"
            || (value.sourceUrl !== null && typeof value.sourceUrl !== "string")
            || (value.sourceFormat !== "vhdx" && value.sourceFormat !== "vhd-tar-gz" && value.sourceFormat !== "vhdx-zip" && value.sourceFormat !== "qcow2" && value.sourceFormat !== "vmdk")
            || (value.sourceSha256 !== null && (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sourceSha256)))
            || (value.licenseId !== null && typeof value.licenseId !== "string")
            || (value.generation !== 1 && value.generation !== 2)
            || (value.secureBootTemplate !== "MicrosoftWindows" && value.secureBootTemplate !== "MicrosoftUEFICertificateAuthority")
            || value.preparationVersion !== 1
            || typeof value.imagePath !== "string"
            || resolve(value.imagePath) !== resolve(expectedImagePath)
            || typeof value.sha256 !== "string"
            || !/^[a-f0-9]{64}$/i.test(value.sha256)
            || typeof value.sizeBytes !== "number"
            || !Number.isSafeInteger(value.sizeBytes)
            || value.sizeBytes <= 0
            || typeof value.virtualSizeBytes !== "number"
            || !Number.isSafeInteger(value.virtualSizeBytes)
            || value.virtualSizeBytes <= 0
            || (value.vhdType !== "Fixed" && value.virtualSizeBytes < value.sizeBytes)
            || (value.vhdType !== "Dynamic" && value.vhdType !== "Fixed")
            || typeof value.preparedAt !== "string") {
            throw new Error("hyper-v-base-image-manifest-invalid");
        }
        return value as HyperVImageManifest;
    }, "hyper-v-base-image-manifest", HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES);
    if (!manifest) throw new Error("hyper-v-base-image-manifest-missing");
    const catalog = profile === "windows-server" || profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG[profile] : null;
    if (manifest.catalogId !== "user-provided-vhdx") {
        const catalogSourceSha256 = catalog && "sourceSha256" in catalog ? catalog.sourceSha256 : null;
        if (!catalog
            || manifest.catalogId !== catalog.catalogId
            || manifest.sourceUrl !== catalog.sourceUrl
            || manifest.sourceFormat !== catalog.sourceFormat
            || manifest.sourceSha256 !== catalogSourceSha256
            || manifest.licenseId !== catalog.licenseId
            || manifest.generation !== catalog.generation
            || manifest.secureBootTemplate !== catalog.secureBootTemplate) {
            throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
        }
        if ("virtualSizeBytes" in catalog && manifest.virtualSizeBytes !== catalog.virtualSizeBytes) {
            throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
        }
    } else if (!allowUserProvided || manifest.sourceUrl !== null || manifest.sourceSha256 !== null || manifest.licenseId !== null || manifest.sourceFormat !== "vhdx") {
        throw new Error("hyper-v-base-image-manifest-provenance-mismatch");
    }
    const image = inspectLargeRegularFile(profileRoot, expectedImagePath, "hyper-v-base-image");
    if (image.size !== manifest.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
    return manifest;
}

async function readHyperVImageManifest(
    privateRoot: string,
    profile: HyperVImageProfile,
    profileRoot = hyperVImageProfileRoot(privateRoot, profile),
    allowUserProvided = false,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVImageManifest> {
    const manifest = readHyperVImageManifestMetadata(privateRoot, profile, profileRoot, allowUserProvided);
    if (await sha256LargeRegularFile(profileRoot, manifest.imagePath, "hyper-v-base-image", deadlineAt) !== manifest.sha256) {
        throw new Error("hyper-v-base-image-hash-mismatch");
    }
    return manifest;
}

function commandSucceeded(result: HyperVImageCommandResult): boolean {
    return result.status === 0 && !result.error;
}

function resolvePowerShell(runtime: HyperVImageStoreRuntime): string | null {
    return runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
}

async function prepareImportedHyperVImage(
    profile: HyperVImageProfile,
    sourceImage: string,
    ownerProfileRoot: string,
    runtime: HyperVImageStoreRuntime,
    powershell: string,
    deadlineAt: number,
): Promise<{ observation: HyperVBaseImageObservation; prepared: boolean }> {
    const imagePath = join(ownerProfileRoot, "base.vhdx");
    const manifestPath = join(ownerProfileRoot, "manifest.json");
    const manifestWasPresent = (() => {
        try { lstatSync(manifestPath); return true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
            throw error;
        }
    })();
    const stagedSource = await stageLargeRegularFileFromProject(resolve(runtime.cwd), sourceImage, ownerProfileRoot, "hyper-v-base-image-source", deadlineAt);
    const client = createDeviceLabHyperVWindowsClient({
        executable: powershell,
        timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, runtime.limits.prepareTimeoutMs),
        run: runtime.run,
    });
    let removeStagedSource = true;
    let partial: string | null = null;
    let publishedIdentity: { dev: number; ino: number } | null = null;
    let manifestTemporaryPath: string | null = null;
    let publishedManifestIdentity: { dev: number; ino: number } | null = null;
    const storage = async (readPartitionStyle: boolean, cleanup = false) => {
        const execution = await runtime.run(hyperVImportedImageStorageCommand({
            executable: powershell, imageRoot: ownerProfileRoot, path: stagedSource, readPartitionStyle,
        }), {
            timeoutMs: cleanup ? 30_000 : hyperVRemainingTimeout(deadlineAt, runtime.limits.prepareTimeoutMs),
            outputLimit: runtime.limits.commandOutputBytes,
        });
        if (!commandSucceeded(execution)) throw new Error(`hyper-v-base-image-storage-failed:${hyperVProviderDiagnosticCode(execution, "hyper-v-powershell-execution-failed")}`);
        const observation = parseHyperVImportedImageStorage(execution.stdout || "", stagedSource);
        if (!observation) throw new Error("hyper-v-base-image-storage-invalid-result");
        return observation;
    };
    try {
        const source = inspectLargeRegularFile(ownerProfileRoot, stagedSource, "hyper-v-base-image-source");
        const sourceSha256 = await sha256LargeRegularFile(ownerProfileRoot, stagedSource, "hyper-v-base-image-source", deadlineAt);
        let reused = false;
        if (existsSync(imagePath)) {
            const existing = inspectLargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image");
            if (existing.size !== source.size || await sha256LargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== sourceSha256) {
                throw new Error("hyper-v-base-image-profile-conflict");
            }
            reused = true;
        }
        const sourceVhd = await client.getVHD(stagedSource);
        const virtualSizeBytes = inspectHyperVCreateVhd({ kind: "base", path: stagedSource }, sourceVhd);
        if (sourceVhd.vhdType !== "Dynamic" && sourceVhd.vhdType !== "Fixed") throw new Error("hyper-v-base-image-type-unsupported");
        if (sourceVhd.fileSizeBytes !== source.size
            || (sourceVhd.vhdType === "Dynamic" && source.size > virtualSizeBytes)) throw new Error("hyper-v-base-image-size-mismatch");
        const beforeMount = await storage(false);
        if (beforeMount.attached) {
            removeStagedSource = false;
            throw new Error("hyper-v-base-image-source-already-mounted");
        }
        let partitionStyle: string | null = null;
        let mountError: unknown = null;
        removeStagedSource = false;
        try {
            await client.mountVHD({ path: stagedSource, readOnly: true, noDriveLetter: true });
            const mounted = await storage(true);
            if (!mounted.attached) throw new Error("hyper-v-base-image-not-mounted");
            partitionStyle = mounted.partitionStyle;
        } catch (error) {
            mountError = error;
        } finally {
            // The staged path belongs only to this transaction, so a lost mount response can
            // safely be followed by a path-based dismount. Keep it if detached readback fails.
            const cleanupClient = createDeviceLabHyperVWindowsClient({
                executable: powershell, timeoutMilliseconds: 30_000, run: runtime.run,
            });
            let dismountError: unknown = null;
            try { await cleanupClient.dismountVHD(stagedSource); } catch (error) { dismountError = error; }
            try {
                const detached = await storage(false, true);
                if (detached.attached) throw new Error("hyper-v-base-image-dismount-failed");
                removeStagedSource = true;
                if (dismountError) throw new Error("hyper-v-base-image-dismount-failed");
            } catch {
                throw new Error("hyper-v-base-image-dismount-failed");
            }
        }
        if (mountError) throw mountError;
        assertHyperVOperationDeadline(deadlineAt);
        const generation = partitionStyle === "GPT" ? 2 : partitionStyle === "MBR" ? 1 : null;
        if (!generation) throw new Error("hyper-v-base-image-partition-style-unsupported");

        if (reused) {
            const existingVhd = await client.getVHD(imagePath);
            if (inspectHyperVCreateVhd({ kind: "base", path: imagePath }, existingVhd) !== virtualSizeBytes
                || existingVhd.fileSizeBytes !== source.size || existingVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-profile-conflict");
        } else {
            partial = await stageLargeRegularFileFromProject(ownerProfileRoot, stagedSource, ownerProfileRoot, "hyper-v-base-image-copy", deadlineAt);
            const copied = inspectLargeRegularFile(ownerProfileRoot, partial, "hyper-v-base-image-copy");
            if (copied.size !== source.size
                || await sha256LargeRegularFile(ownerProfileRoot, partial, "hyper-v-base-image-copy", deadlineAt) !== sourceSha256) {
                throw new Error("hyper-v-base-image-hash-mismatch");
            }
            const copiedVhd = await client.getVHD(partial);
            if (inspectHyperVCreateVhd({ kind: "base", path: partial }, copiedVhd) !== virtualSizeBytes
                || copiedVhd.fileSizeBytes !== source.size || copiedVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-size-mismatch");
            assertHyperVOperationDeadline(deadlineAt);
            const partialStat = await fsPromises.lstat(partial);
            await fsPromises.link(partial, imagePath);
            publishedIdentity = { dev: partialStat.dev, ino: partialStat.ino };
            await fsPromises.unlink(partial);
            partial = null;
            const final = inspectLargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image");
            if (final.size !== source.size
                || await sha256LargeRegularFile(ownerProfileRoot, imagePath, "hyper-v-base-image", deadlineAt) !== sourceSha256) {
                throw new Error("hyper-v-base-image-hash-mismatch");
            }
            const finalVhd = await client.getVHD(imagePath);
            if (inspectHyperVCreateVhd({ kind: "base", path: imagePath }, finalVhd) !== virtualSizeBytes
                || finalVhd.fileSizeBytes !== source.size || finalVhd.vhdType !== sourceVhd.vhdType) throw new Error("hyper-v-base-image-size-mismatch");
        }
        const observation: HyperVBaseImageObservation = {
            ok: true, profile, imagePath, sha256: sourceSha256, sizeBytes: source.size,
            virtualSizeBytes, vhdType: sourceVhd.vhdType, generation, reused,
        };
        if (manifestWasPresent) {
            const existingManifest = readHyperVImageManifestMetadata(runtime.privateRoot, profile, ownerProfileRoot, true);
            if (existingManifest.sha256 !== sourceSha256
                || existingManifest.sizeBytes !== source.size
                || existingManifest.virtualSizeBytes !== virtualSizeBytes
                || existingManifest.vhdType !== sourceVhd.vhdType
                || existingManifest.generation !== generation) throw new Error("hyper-v-base-image-profile-conflict");
            assertHyperVOperationDeadline(deadlineAt);
            return { observation, prepared: !reused };
        }
        assertHyperVOperationDeadline(deadlineAt);
        const manifest = hyperVImageManifest(profile, imagePath, observation, false);
        const manifestBytes = JSON.stringify(manifest, null, 2);
        if (Buffer.byteLength(manifestBytes) > HYPER_V_IMAGE_MANIFEST_LIMIT_BYTES) throw new Error("hyper-v-base-image-manifest-invalid");
        manifestTemporaryPath = join(ownerProfileRoot, `.manifest-${randomBytes(12).toString("hex")}.tmp`);
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        const manifestDescriptor = await fsPromises.open(manifestTemporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
        let temporaryIdentity: { dev: number; ino: number };
        try {
            await manifestDescriptor.writeFile(manifestBytes);
            await manifestDescriptor.sync();
            const temporary = await manifestDescriptor.stat();
            if (!temporary.isFile() || temporary.nlink !== 1 || temporary.size !== Buffer.byteLength(manifestBytes)) {
                throw new Error("hyper-v-base-image-manifest-invalid");
            }
            temporaryIdentity = { dev: temporary.dev, ino: temporary.ino };
        } finally {
            await manifestDescriptor.close();
        }
        assertHyperVOperationDeadline(deadlineAt);
        await fsPromises.link(manifestTemporaryPath, manifestPath);
        publishedManifestIdentity = temporaryIdentity;
        await fsPromises.unlink(manifestTemporaryPath);
        manifestTemporaryPath = null;
        assertHyperVOperationDeadline(deadlineAt);
        return { observation, prepared: !reused };
    } catch (error) {
        if (publishedManifestIdentity) {
            try {
                const current = await fsPromises.lstat(manifestPath);
                if (current.dev === publishedManifestIdentity.dev && current.ino === publishedManifestIdentity.ino) await fsPromises.unlink(manifestPath);
            } catch { /* preserve the original failure */ }
        }
        if (publishedIdentity) {
            try {
                const current = await fsPromises.lstat(imagePath);
                if (current.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino) await fsPromises.unlink(imagePath);
            } catch { /* preserve the original failure */ }
        }
        throw error;
    } finally {
        if (manifestTemporaryPath) { try { await fsPromises.unlink(manifestTemporaryPath); } catch { /* best effort */ } }
        if (partial) { try { await fsPromises.unlink(partial); } catch { /* best effort */ } }
        if (removeStagedSource) { try { await fsPromises.unlink(stagedSource); } catch { /* best effort */ } }
    }
}

async function acquireAutomaticHyperVImage(
    profile: "windows-server" | "ubuntu-lts",
    globalProfileRoot: string,
    runtime: HyperVImageStoreRuntime,
    powershell: string,
    acquireDeadlineAt: number,
): Promise<HyperVBaseImageObservation> {
    const imageRoot = hyperVImageRoot(runtime.privateRoot);
    const imagePath = join(globalProfileRoot, "base.vhdx");
    const partialPath = join(globalProfileRoot, "base.partial.vhdx");
    const workPath = join(globalProfileRoot, ".acquire-work");
    const ownedArtifacts = new Map<string, AutomaticArtifactIdentity>();
    const options = {
        executable: powershell, profile, imageRoot,
        expectedGeneration: 2 as const,
    } as const;
    const client = createDeviceLabHyperVWindowsClient({
        executable: powershell,
        timeoutMilliseconds: () => hyperVRemainingTimeout(acquireDeadlineAt, runtime.limits.acquireTimeoutMs),
        run: runtime.run,
    });
    const runStage = async (command: HyperVProviderCommand) => {
        const result = await runtime.run(command, {
            timeoutMs: hyperVRemainingTimeout(acquireDeadlineAt, runtime.limits.acquireTimeoutMs),
            outputLimit: runtime.limits.commandOutputBytes,
        });
        assertHyperVOperationDeadline(acquireDeadlineAt);
        if (!commandSucceeded(result)) {
            throw new Error(`hyper-v-base-image-acquire-failed:${hyperVProviderDiagnosticCode(result, "hyper-v-powershell-execution-failed")}`);
        }
        return result.stdout || "";
    };
    const inspectVhd = async (
        path: string, format: "VHD" | "VHDX", expectedType?: "Fixed" | "Dynamic",
    ): Promise<HyperVVirtualHardDisk> => {
        const file = inspectLargeRegularFile(globalProfileRoot, path, "hyper-v-base-image-vhd");
        const vhd = await client.getVHD(path);
        if (win32.normalize(vhd.path).toLowerCase() !== win32.normalize(path).toLowerCase()
            || vhd.vhdFormat !== format || vhd.parentPath !== null
            || (vhd.vhdType !== "Fixed" && vhd.vhdType !== "Dynamic")
            || (expectedType && vhd.vhdType !== expectedType)
            || !Number.isSafeInteger(vhd.virtualSizeBytes) || vhd.virtualSizeBytes <= 0
            || vhd.fileSizeBytes !== file.size) {
            throw new Error("hyper-v-base-image-vhd-invalid");
        }
        return vhd;
    };
    try {
        const prepared = parseHyperVAcquireBaseImagePrepareObservation(
            await runStage(hyperVAcquireBaseImagePrepareCommand(options)),
        );
        if (!prepared || prepared.profile !== profile
            || resolve(prepared.imagePath) !== resolve(imagePath)
            || resolve(prepared.partialPath) !== resolve(partialPath)) {
            throw new Error("hyper-v-base-image-acquire-invalid-result");
        }
        for (const path of [partialPath, workPath]) {
            const identity = automaticArtifactIdentity(path);
            if (identity) ownedArtifacts.set(path, identity);
        }
        let expectedSourceVhdSha256: string | undefined;
        let expectedSourceFileId: string | undefined;
        let expectedQemuSha256: string | undefined;
        let expectedPartialSha256: string;
        let expectedPartialFileId: string;
        let expectedVirtualSizeBytes: number;
        let expectedVhdType: "Fixed" | "Dynamic";
        if (prepared.profile === "ubuntu-lts") {
            const sourcePath = join(globalProfileRoot, ".acquire-work", "converted.normalized.fixed.vhd");
            if (resolve(prepared.sourceVhdPath) !== resolve(sourcePath)) throw new Error("hyper-v-base-image-source-path-invalid");
            const sourceIdentity = automaticArtifactIdentity(sourcePath);
            if (!sourceIdentity || sourceIdentity.directory) throw new Error("hyper-v-base-image-source-invalid");
            const sourceHashBefore = await sha256LargeRegularFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt);
            if (sourceHashBefore !== prepared.sourceVhdSha256) throw new Error("hyper-v-base-image-source-mutated");
            const sourceVhd = await inspectVhd(sourcePath, "VHD", "Fixed");
            if (sourceVhd.virtualSizeBytes !== prepared.sourceVirtualSizeBytes
                || sourceVhd.virtualSizeBytes > HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes) {
                throw new Error("hyper-v-base-image-source-format-invalid");
            }
            if (await sha256LargeRegularFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt) !== sourceHashBefore) {
                throw new Error("hyper-v-base-image-source-mutated");
            }
            assertAutomaticFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
            await client.convertVHD({ sourcePath, destinationPath: partialPath, vhdType: "Dynamic" }, {
                timeoutMilliseconds: hyperVRemainingTimeout(acquireDeadlineAt, runtime.limits.acquireTimeoutMs),
            });
            const convertedIdentity = automaticArtifactIdentity(partialPath);
            if (convertedIdentity) ownedArtifacts.set(partialPath, convertedIdentity);
            if (await sha256LargeRegularFile(globalProfileRoot, sourcePath, "hyper-v-base-image-source", acquireDeadlineAt) !== sourceHashBefore) {
                throw new Error("hyper-v-base-image-source-mutated");
            }
            assertAutomaticFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
            const partialIdentity = automaticArtifactIdentity(partialPath);
            if (!partialIdentity || partialIdentity.directory) throw new Error("hyper-v-base-image-partial-invalid");
            let partialVhd = await inspectVhd(partialPath, "VHDX", "Dynamic");
            assertAutomaticFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
            const targetSize = HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes;
            if (partialVhd.virtualSizeBytes > targetSize) throw new Error("hyper-v-base-image-convert-failed");
            if (partialVhd.virtualSizeBytes < targetSize) {
                await client.resizeVHD({ path: partialPath, sizeBytes: targetSize }, {
                    timeoutMilliseconds: hyperVRemainingTimeout(acquireDeadlineAt, runtime.limits.acquireTimeoutMs),
                });
                partialVhd = await inspectVhd(partialPath, "VHDX", "Dynamic");
                assertAutomaticFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
            }
            if (partialVhd.virtualSizeBytes !== targetSize) throw new Error("hyper-v-base-image-convert-failed");
            expectedSourceVhdSha256 = sourceHashBefore;
            expectedSourceFileId = sourceIdentity.ino.toString();
            expectedQemuSha256 = prepared.qemuSha256;
            expectedPartialSha256 = await sha256LargeRegularFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial", acquireDeadlineAt);
            expectedPartialFileId = partialIdentity.ino.toString();
            assertAutomaticFileIdentity(sourcePath, sourceIdentity, "hyper-v-base-image-source");
            assertAutomaticFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
            expectedVirtualSizeBytes = partialVhd.virtualSizeBytes;
            expectedVhdType = "Dynamic";
        } else {
            const partialFile = inspectLargeRegularFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial");
            const partialIdentity = automaticArtifactIdentity(partialPath);
            if (!partialIdentity || partialIdentity.directory) throw new Error("hyper-v-base-image-partial-invalid");
            expectedPartialSha256 = await sha256LargeRegularFile(globalProfileRoot, partialPath, "hyper-v-base-image-partial", acquireDeadlineAt);
            expectedPartialFileId = partialIdentity.ino.toString();
            if (partialFile.size !== prepared.partialSizeBytes || expectedPartialSha256 !== prepared.partialSha256) {
                throw new Error("hyper-v-base-image-partial-mutated");
            }
            const partialVhd = await inspectVhd(partialPath, "VHDX");
            assertAutomaticFileIdentity(partialPath, partialIdentity, "hyper-v-base-image-partial");
            expectedVirtualSizeBytes = partialVhd.virtualSizeBytes;
            expectedVhdType = partialVhd.vhdType as "Fixed" | "Dynamic";
        }
        const finalizeCommon = {
            executable: powershell, imageRoot, expectedGeneration: 2 as const,
            expectedPartialSha256, expectedPartialFileId, expectedVirtualSizeBytes, expectedVhdType,
        };
        const finalizeCommand = profile === "ubuntu-lts"
            ? hyperVAcquireBaseImageFinalizeCommand({
                ...finalizeCommon, profile,
                expectedSourceVhdSha256: expectedSourceVhdSha256!, expectedSourceFileId: expectedSourceFileId!, expectedQemuSha256: expectedQemuSha256!,
            })
            : hyperVAcquireBaseImageFinalizeCommand({ ...finalizeCommon, profile });
        const observation = parseHyperVBaseImageObservation(await runStage(finalizeCommand));
        if (!observation || observation.profile !== profile || resolve(observation.imagePath) !== resolve(imagePath)
            || observation.generation !== HYPER_V_IMAGE_CATALOG[profile].generation
            || observation.virtualSizeBytes !== expectedVirtualSizeBytes
            || observation.vhdType !== expectedVhdType) {
            throw new Error("hyper-v-base-image-acquire-invalid-result");
        }
        const finalVhd = await inspectVhd(imagePath, "VHDX", expectedVhdType);
        if (finalVhd.virtualSizeBytes !== observation.virtualSizeBytes) throw new Error("hyper-v-base-image-final-inspection-failed");
        cleanupOwnedAutomaticArtifacts(globalProfileRoot, ownedArtifacts);
        return observation;
    } catch (error) {
        // The finalizer has released its handle before a later typed read or broker check.
        // A path stat or matching hash cannot prove who created base.vhdx if it was replaced.
        // Keep any unmanifested base for guarded recovery and clean only known work paths.
        try { cleanupOwnedAutomaticArtifacts(globalProfileRoot, ownedArtifacts); }
        catch { /* preserve the original failure and leave uncertain artifacts in place */ }
        for (const [path, label] of [
            [partialPath, "partial-uncertain"], [workPath, "work-uncertain"],
        ] as const) {
            try { quarantineUncertainAutomaticArtifact(globalProfileRoot, path, label); }
            catch { /* an unsafe or changed path remains for explicit guarded recovery */ }
        }
        if (hyperVOperationDeadlineExpired(acquireDeadlineAt)) throw new HyperVOperationDeadlineError();
        throw error;
    }
}

function hyperVImageEntryPresent(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
    }
}

// isKnownPriorAutomaticImage without the hash: the prior-catalog manifest and an image file of its size.
function knownPriorAutomaticImageMetadata(profileRoot: string, manifestPath: string, imageFile: string): boolean {
    try {
        const prior = readKnownPriorAutomaticManifest(profileRoot, manifestPath);
        return !!prior && inspectLargeRegularFile(profileRoot, imageFile, "hyper-v-base-image-prior").size === prior.sizeBytes;
    } catch {
        return false;
    }
}

// Readiness view of the ubuntu-lts cache decision that resolveHyperVImageForCreate makes before
// acquisition. It reads manifests and file metadata only: nothing is hashed, written, locked,
// cleaned up or recovered, so it fits the smoke and device_backends budgets. Create remains the
// trust gate and hashes base.vhdx before use, so an image that passes here can still fail there.
export function inspectHyperVUbuntuImageCache(privateRoot: string, ownerId: string): HyperVUbuntuImageCacheInspection {
    const profileConflict = { state: "conflict", code: "hyper-v-base-image-profile-conflict" } as const;
    const globalProfileRoot = hyperVImageProfileRoot(privateRoot, "ubuntu-lts");
    const manifestPath = join(globalProfileRoot, "manifest.json");
    const imagePath = join(globalProfileRoot, "base.vhdx");
    const backup = priorRecoveryPaths(globalProfileRoot);
    let backupPresent: boolean;
    let priorRestorable = false;
    try {
        // Create prepares into the shared root and, before it reads any cache, restores a prior-catalog
        // pair whose retirement was interrupted. An unsafe root or a pair it cannot restore stops create
        // even when the owner has a valid image; recoverPriorAutomaticImage decides the same way.
        assertNoSymlinkPathComponents(globalProfileRoot, "hyper-v-base-image-cache-inspection");
        if (hyperVImageEntryPresent(globalProfileRoot) && !lstatSync(globalProfileRoot).isDirectory()) return profileConflict;
        backupPresent = hyperVImageEntryPresent(backup.manifest) || hyperVImageEntryPresent(backup.image);
        if (backupPresent && !(hyperVImageEntryPresent(manifestPath) && hyperVImageEntryPresent(imagePath))) {
            const manifestFile = hyperVImageEntryPresent(backup.manifest) ? backup.manifest : manifestPath;
            const imageFile = hyperVImageEntryPresent(backup.image) ? backup.image : imagePath;
            if ((manifestFile === backup.manifest && hyperVImageEntryPresent(manifestPath))
                || !knownPriorAutomaticImageMetadata(globalProfileRoot, manifestFile, imageFile)) return profileConflict;
            priorRestorable = true;
        }
    } catch {
        return profileConflict;
    }
    if (HYPER_V_IMAGE_OWNER_ID_PATTERN.test(ownerId)) {
        try {
            readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts", hyperVOwnerImageProfileRoot(privateRoot, ownerId, "ubuntu-lts"), true);
            return { state: "valid", source: "owner" };
        } catch { /* create falls back to the shared automatic cache */ }
    }
    // A restorable prior pair is retired and reacquired, like a prior-catalog manifest in place.
    if (priorRestorable) {
        try {
            return hyperVImageEntryPresent(join(globalProfileRoot, "base.partial.vhdx"))
                || hyperVImageEntryPresent(join(globalProfileRoot, ".acquire-work"))
                ? { state: "conflict", code: "hyper-v-base-image-artifact-owner-unknown" }
                : { state: "acquisition-required" };
        } catch {
            return profileConflict;
        }
    }
    try {
        readHyperVImageManifestMetadata(privateRoot, "ubuntu-lts", globalProfileRoot, false);
        return { state: "valid", source: "global" };
    } catch { /* classify what create would do without a usable cache */ }
    try {
        let priorCatalog = false;
        if (hyperVImageEntryPresent(manifestPath)) {
            // Only the immediately previous catalog, with its image in place, is retired and
            // reacquired; any other manifest that failed validation is left for the operator.
            if (!knownPriorAutomaticImageMetadata(globalProfileRoot, manifestPath, imagePath)) return profileConflict;
            priorCatalog = true;
        } else if (hyperVImageEntryPresent(imagePath)) {
            return { state: "conflict", code: "hyper-v-base-image-unmanaged-existing" };
        }
        if (hyperVImageEntryPresent(join(globalProfileRoot, "base.partial.vhdx"))
            || hyperVImageEntryPresent(join(globalProfileRoot, ".acquire-work"))) {
            return { state: "conflict", code: "hyper-v-base-image-artifact-owner-unknown" };
        }
        // Retirement refuses to overwrite the backups an earlier retirement left beside a complete pair.
        if (priorCatalog && backupPresent) return profileConflict;
        return { state: "acquisition-required" };
    } catch {
        // An unreadable image root is one create cannot prepare into either.
        return profileConflict;
    }
}

export async function resolveHyperVImageForCreate(
    ownerId: string,
    request: HyperVImageCreateRequest,
    params: unknown,
    runtime: HyperVImageStoreRuntime,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HyperVImageResolution> {
    const input = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const create = request.create || {};
    const profile = hyperVImageProfile(create.profile || (request.backend === "linux-vm" ? "ubuntu-lts" : "windows-server"));
    if (!profile) {
        return { ok: false, status: 400, error: "hyper-v-image-profile-invalid", detail: "profile must be windows-11, windows-server, or ubuntu-lts" };
    }
    const globalProfileRoot = hyperVImageProfileRoot(runtime.privateRoot, profile);
    const ownerProfileRoot = hyperVOwnerImageProfileRoot(runtime.privateRoot, ownerId, profile);
    if (typeof create.image === "string" && create.image) {
        try {
            const requestedImage = resolve(create.image);
            const ownerImage = resolve(join(ownerProfileRoot, "base.vhdx"));
            const globalImage = resolve(join(globalProfileRoot, "base.vhdx"));
            const manifest = requestedImage === ownerImage
                ? await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt)
                : requestedImage === globalImage
                    ? await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt)
                    : (() => { throw new Error("hyper-v-base-image-manifest-path-mismatch"); })();
            if (resolve(create.image) !== resolve(manifest.imagePath)) throw new Error("hyper-v-base-image-manifest-path-mismatch");
            return { ok: true, params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes }, imagePath: manifest.imagePath, prepared: false };
        } catch (error) {
            if (error instanceof HyperVOperationDeadlineError) throw error;
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                detail: hyperVBoundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                remedy: "import the generalized VHDX with --source-image",
            };
        }
    }

    const sourceImage = typeof create.sourceImage === "string" && create.sourceImage ? resolve(runtime.cwd, create.sourceImage) : null;
    if (request.dryRun) {
        if (sourceImage) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                remedy: "run device_create without --dry-run once to import and validate the source image",
            };
        }
        try {
            let manifest: HyperVImageManifest;
            try {
                manifest = await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
            } catch {
                manifest = await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt);
            }
            return {
                ok: true,
                params: { ...input, profile, image: manifest.imagePath, baseImageSha256: manifest.sha256, baseImageGeneration: manifest.generation, diskMaxBytes: manifest.virtualSizeBytes },
                imagePath: manifest.imagePath,
                prepared: false,
            };
        } catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-base-image-not-prepared",
                detail: hyperVBoundedErrorCode(error, "hyper-v-base-image-not-prepared"),
                remedy: "run device_create without --dry-run once to acquire and validate the base image",
            };
        }
    }

    const preparationRoot = sourceImage ? ownerProfileRoot : globalProfileRoot;
    try {
        mkdirSync(preparationRoot, { recursive: true, mode: 0o700 });
        assertNoSymlinkPathComponents(preparationRoot, "hyper-v-base-image-preparation");
        const preparationMetadata = lstatSync(preparationRoot);
        if (!preparationMetadata.isDirectory() || preparationMetadata.isSymbolicLink()) throw new Error("hyper-v-base-image-preparation-root-invalid");
        return await withSharedMutationLockAsync(join(preparationRoot, "prepare.lock"), async () => {
            assertHyperVOperationDeadline(deadlineAt);
            if (!sourceImage) {
                const acquireDeadlineAt = Math.min(deadlineAt, Date.now() + runtime.limits.acquireTimeoutMs);
                if (profile === "ubuntu-lts") await recoverPriorAutomaticImage(globalProfileRoot, acquireDeadlineAt);
                let retiredPrior: {
                    prior: { manifestBytes: Buffer; imageSha256: string; imageSize: number };
                    identities: { manifest: AutomaticArtifactIdentity; image: AutomaticArtifactIdentity };
                } | null = null;
                let pendingPrior: { manifestBytes: Buffer; imageSha256: string; imageSize: number } | null = null;
                let cachedManifest: HyperVImageManifest | null = null;
                try {
                    cachedManifest = await readHyperVImageManifest(runtime.privateRoot, profile, ownerProfileRoot, true, deadlineAt);
                } catch (cacheError) {
                    if (cacheError instanceof HyperVOperationDeadlineError) throw cacheError;
                    try {
                        cachedManifest = await readHyperVImageManifest(runtime.privateRoot, profile, globalProfileRoot, false, deadlineAt);
                    } catch (globalCacheError) {
                        if (globalCacheError instanceof HyperVOperationDeadlineError) throw globalCacheError;
                        if (profile === "windows-11") {
                            throw new Error(`hyper-v-base-image-profile-not-automatic:${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
                        }
                        assertNoSymlinkPathComponents(globalProfileRoot, "hyper-v-base-image-cleanup");
                        if (existsSync(join(globalProfileRoot, "manifest.json"))) {
                            const prior = await isKnownPriorAutomaticImage(profile, globalProfileRoot, acquireDeadlineAt);
                            if (!prior) {
                                throw new Error("hyper-v-base-image-profile-conflict");
                            }
                            pendingPrior = prior;
                        } else if (existsSync(join(globalProfileRoot, "base.vhdx"))) {
                            throw new Error("hyper-v-base-image-unmanaged-existing");
                        }
                    }
                }
                if (cachedManifest) {
                    if (cachedManifest.licenseId && !readHyperVWindowsEvaluationReceipt(join(runtime.privateRoot, "setup"))) {
                        throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                    }
                    return {
                        ok: true as const,
                        params: { ...input, profile, image: cachedManifest.imagePath, baseImageSha256: cachedManifest.sha256, baseImageGeneration: cachedManifest.generation, diskMaxBytes: cachedManifest.virtualSizeBytes },
                        imagePath: cachedManifest.imagePath,
                        prepared: false,
                    };
                }
                if (profile === "windows-server" && !readHyperVWindowsEvaluationReceipt(join(runtime.privateRoot, "setup"))) {
                    throw new Error("hyper-v-windows-evaluation-license-not-accepted");
                }
                const automaticProfile = profile === "windows-server" || profile === "ubuntu-lts" ? profile : null;
                if (!automaticProfile) throw new Error("hyper-v-base-image-profile-not-automatic");
                const powershell = resolvePowerShell(runtime);
                if (!powershell) throw new Error("missing-provider-command:powershell");
                const imagePath = join(globalProfileRoot, "base.vhdx");
                if (automaticArtifactIdentity(join(globalProfileRoot, "base.partial.vhdx"))
                    || automaticArtifactIdentity(join(globalProfileRoot, ".acquire-work"))) {
                    throw new Error("hyper-v-base-image-artifact-owner-unknown");
                }
                try {
                    if (pendingPrior) {
                        const identities = await retireKnownPriorAutomaticImage(globalProfileRoot, pendingPrior, acquireDeadlineAt);
                        retiredPrior = { prior: pendingPrior, identities };
                    }
                    const observation = await acquireAutomaticHyperVImage(
                        automaticProfile, globalProfileRoot, runtime, powershell, acquireDeadlineAt,
                    );
                    if (hyperVOperationDeadlineExpired(acquireDeadlineAt)) throw new HyperVOperationDeadlineError();
                    if (!observation
                        || observation.profile !== profile
                        || observation.generation !== HYPER_V_IMAGE_CATALOG[automaticProfile].generation
                        || resolve(observation.imagePath) !== resolve(imagePath)) {
                        throw new Error("hyper-v-base-image-acquire-invalid-result");
                    }
                    const image = inspectLargeRegularFile(globalProfileRoot, imagePath, "hyper-v-base-image");
                    if (image.size !== observation.sizeBytes) throw new Error("hyper-v-base-image-size-mismatch");
                    if (await sha256LargeRegularFile(globalProfileRoot, imagePath, "hyper-v-base-image", acquireDeadlineAt) !== observation.sha256) {
                        throw new Error("hyper-v-base-image-hash-mismatch");
                    }
                    const manifest = hyperVImageManifest(profile, imagePath, observation, true);
                    assertHyperVOperationDeadline(acquireDeadlineAt);
                    writeJsonFileAtomically(join(globalProfileRoot, "manifest.json"), manifest);
                    if (retiredPrior) {
                        try {
                            await discardRetiredPriorAutomaticImage(globalProfileRoot, retiredPrior.prior, retiredPrior.identities, acquireDeadlineAt);
                        } catch { /* the committed current pair remains valid; retain backups for guarded recovery */ }
                    }
                    return {
                        ok: true as const,
                        params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                        imagePath,
                        prepared: !observation.reused,
                    };
                } catch (error) {
                    if (retiredPrior) {
                        try { await recoverPriorAutomaticImage(globalProfileRoot, acquireDeadlineAt); }
                        catch { /* preserve an uncertain new base and the recoverable prior pair */ }
                    }
                    throw error;
                }
            }

            if (!/\.vhdx$/i.test(sourceImage)) throw new Error("hyper-v-base-image-format-unsupported");
            const powershell = resolvePowerShell(runtime);
            if (!powershell) throw new Error("missing-provider-command:powershell");
            const imagePath = join(ownerProfileRoot, "base.vhdx");
            const { observation, prepared } = await prepareImportedHyperVImage(profile, sourceImage, ownerProfileRoot, runtime, powershell, deadlineAt);
            return {
                ok: true as const,
                params: { ...input, profile, image: imagePath, baseImageSha256: observation.sha256, baseImageGeneration: observation.generation, diskMaxBytes: observation.virtualSizeBytes },
                imagePath,
                prepared,
            };
        }, {
            waitMs: hyperVRemainingTimeout(deadlineAt, runtime.limits.lockWaitMs),
            staleMs: HYPER_V_IMAGE_LOCK_STALE_MS,
        });
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const publicDetail = hyperVBoundedErrorDetail(error, "hyper-v-base-image-prepare-failed");
        const licenseMissing = detail.includes("hyper-v-windows-evaluation-license-not-accepted");
        const automaticUnsupported = detail.includes("hyper-v-base-image-profile-not-automatic");
        const notPrepared = !sourceImage && (detail.includes("ENOENT") || detail.includes("not found") || detail.includes("manifest-missing") || automaticUnsupported);
        const profileConflict = detail.includes("hyper-v-base-image-profile-conflict") || detail.includes("hyper-v-base-image-unmanaged-existing")
            || detail.includes("hyper-v-base-image-artifact-owner-unknown");
        return {
            ok: false,
            status: licenseMissing || notPrepared || profileConflict ? 409 : 422,
            error: licenseMissing
                ? "hyper-v-windows-evaluation-license-not-accepted"
                : notPrepared
                    ? "hyper-v-base-image-not-prepared"
                    : profileConflict
                        ? "hyper-v-base-image-profile-conflict"
                        : "hyper-v-base-image-prepare-failed",
            detail: publicDetail,
            remedy: licenseMissing
                ? "review the Microsoft Windows Server evaluation terms, then run ccc devices setup hyper-v --confirm --accept-windows-evaluation-license"
                : notPrepared
                    ? "provide --source-image with a generalized Windows 11 VHDX, or use the automatic windows-server profile"
                    : undefined,
        };
    }
}
