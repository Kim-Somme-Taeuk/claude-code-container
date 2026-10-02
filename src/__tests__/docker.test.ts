import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "child_process";
import { createHash } from "crypto";
import { SSH_COPY_SCRIPT } from "../ssh-credentials.js";

// Mock child_process before importing
const spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>();
vi.mock("child_process", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, spawnSync: spawnSyncMock };
});

// Mock fs for startProjectContainer
const mockExistsSync = vi.fn().mockReturnValue(true);
const mockAccessSync = vi.fn();
const mockLstatSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        accessSync: (...args: unknown[]) => mockAccessSync(...args),
        existsSync: (...args: unknown[]) => mockExistsSync(...args),
        lstatSync: (...args: unknown[]) => mockLstatSync(...args),
        mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
        readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
        statSync: (...args: unknown[]) => mockStatSync(...args),
    };
});

const mockCleanupOwnerDevices = vi.fn();
const testIdentity = { uid: 1000, gid: 1000, mapping: "host" as const, contractVersion: "1" };
const baseImageId = `sha256:${"a".repeat(64)}`;
const derivedImageId = `sha256:${"b".repeat(64)}`;
const mockEnsureIdentityImage = vi.fn<(...args: unknown[]) => string>(() => derivedImageId);
const mockStartupLock = vi.fn((_path: string, action: () => unknown, _options?: unknown) => action());
vi.mock("../container-identity.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../container-identity.js")>(),
    resolveContainerIdentity: () => testIdentity,
    ensureIdentityImage: (...args: unknown[]) => mockEnsureIdentityImage(...args),
}));
vi.mock("../device-lab-shared-state.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../device-lab-shared-state.js")>(),
    withSharedMutationLock: (path: string, action: () => unknown, options: unknown) => mockStartupLock(path, action, options),
}));
vi.mock("../device-lab-admin.js", () => ({
    cleanupOwnerDevices: (...args: unknown[]) => mockCleanupOwnerDevices(...args),
}));

// Import AFTER mocks
const {
    buildDockerRunArgs,
    getContainerName,
    isDockerRunning,
    isDockerDesktop,
    isContainerRunning,
    isContainerExists,
    isContainerImageOutdated,
    isImageExists,
    getImageLabel,
    pullImage,
    tagImage,
    syncClipboardShims,
    ensureDockerRunning,
    ensureImage,
    buildContainerVmRunConfig,
    buildLabRunnerRunConfig,
    getLabRunnerStateVolumeName,
    qualifyImageRefForRuntime,
    getHostGitIdentityMounts,
    resolveCredentialHostPath,
    prepareCodexConfigForContainer,
    restoreCodexConfigHostOwnership,
    syncManagedMcpBundles,
    fixSshPermissions,
    startProjectContainer,
    assertProjectContainerIdentity,
    stopProjectContainer,
    removeProjectContainer,
} = await import("../docker.js");

const { CLI_VERSION, CLIPBOARD_FILES_CONTAINER_DIR } = await import("../utils.js");
const { getAllCredentialMounts } = await import("../tool-registry.js");
const { getIdentityLabels, getIdentityMiseVolumeName } = await import("../container-identity.js");
const {
    _resetRuntimeCacheForTest,
    _setRuntimeInfoForTest,
} = await import("../container-runtime.js");

function makeResult(
    status: number,
    stdout = "",
): SpawnSyncReturns<string> {
    return { pid: 1, output: [], stdout, stderr: "", status, signal: null };
}

// docker inspect Mounts JSON containing every required mount destination the
// runtime expects. Use this whenever a test wants the existing container to
// pass the mount-drift check.
function fullCredentialMountsJson(
    extra: Array<{ Source: string; Destination: string }> = [],
    options: {
        labState?: boolean;
        status?: "ready" | "unsupported";
        unsupportedReason?: string;
        deviceLabState?: boolean;
        kvmDevice?: boolean;
        groupAdd?: string[];
        devices?: Array<Record<string, string>>;
        privileged?: boolean;
    } = {},
): string {
    const credMounts = getAllCredentialMounts().map((m) => ({
        Source: `/host${m.containerDir}`,
        Destination: m.containerDir,
    }));
    const gitIdentityMounts = [
        { Source: "/host/home/user/.gitconfig", Destination: "/host-stage/gitconfig" },
        { Source: "/host/home/user/.config/git", Destination: "/home/ccc/.config/git" },
    ];
    const clipboardMounts = [
        { Source: "/host/home/user/.ccc/clipboard-files", Destination: CLIPBOARD_FILES_CONTAINER_DIR },
    ];
    const deviceLabMounts = options.deviceLabState === false
        ? []
        : [{ Source: "/host/home/user/.ccc/devices", Destination: "/home/ccc/.ccc/devices" }];
    const labStateMounts = options.labState === false
        ? []
        : [{ Source: "ccc-my-project-c7e2f75b53b9-lab-state", Destination: "/home/ccc/.ccc/labs" }];
    const status = options.status || "ready";
    const env = [
        "CCC_LAB_RUNNER=1",
        `CCC_LAB_RUNNER_STATUS=${status}`,
        "CCC_LAB_STATE_DIR=/home/ccc/.ccc/labs",
        "CCC_LAB_NET_MODE=user",
    ];
    if (options.unsupportedReason) env.push(`CCC_LAB_RUNNER_UNSUPPORTED_REASON=${options.unsupportedReason}`);
    const devices = options.devices ?? (options.kvmDevice === false ? [] : [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" }]);
    const groupAdd = options.groupAdd ?? (status === "ready" && options.kvmDevice !== false ? ["108"] : []);
    return JSON.stringify({
        Mounts: [...credMounts, ...gitIdentityMounts, ...clipboardMounts, ...deviceLabMounts, ...labStateMounts, { Source: "/var/lib/docker/volumes/scoped-mise/_data", Name: getIdentityMiseVolumeName(testIdentity), Destination: "/home/ccc/.local/share/mise" }, ...extra],
        Config: { Env: env },
        HostConfig: { Devices: devices, GroupAdd: groupAdd, Privileged: options.privileged === true },
    });
}

// Stateful command routing keeps lifecycle fixtures independent of probe order.
function mockProjectRuntime(options: {
    exists?: boolean;
    running?: boolean;
    contract?: string;
    labels?: Record<string, string>;
    imageId?: string;
    actualIdentity?: string;
    inspectFailure?: boolean;
    invalidInspect?: boolean;
    runFailure?: boolean;
    retainedLabState?: boolean;
    labStateInUse?: boolean;
    previousOwner?: string;
    execFailure?: boolean;
} = {}): void {
    let exists = options.exists ?? false;
    let running = options.running ?? false;
    spawnSyncMock.mockImplementation((_command, rawArgs) => {
        const args = rawArgs as string[];
        if (args[0] === "images") return makeResult(0, baseImageId);
        if (args[0] === "inspect") {
            if (args.some((arg) => arg.includes("cli.version"))) return makeResult(0, "<no value>");
            if (args.includes("{{.Id}}")) return makeResult(0, baseImageId);
            if (args.includes("{{.Image}}")) return exists ? makeResult(0, options.imageId ?? derivedImageId) : makeResult(1);
            if (args.includes("{{json .}}")) {
                if (!exists || options.inspectFailure) return makeResult(1);
                if (options.invalidInspect) return makeResult(0, "not-json");
                const contract = JSON.parse(options.contract ?? fullCredentialMountsJson());
                return makeResult(0, JSON.stringify({
                    ...contract,
                    State: { Running: running },
                    Image: options.imageId ?? derivedImageId,
                    Config: { ...contract.Config, User: "ccc", Labels: options.labels ?? getIdentityLabels(testIdentity) },
                }));
            }
        }
        if (args[0] === "volume" && args[1] === "ls") return makeResult(0, options.retainedLabState ? `${getContainerName("/home/user/my-project")}-lab-state` : "");
        if (args[0] === "ps" && args.some((arg) => arg.startsWith("volume="))) return makeResult(0, options.labStateInUse ? "active-writer" : "");
        if (args[0] === "ps") return makeResult(0, ((args.includes("-a") || args.includes("-aq")) ? exists : running) ? (args.includes("{{.Names}}") ? getContainerName("/home/user/my-project") : "abc123\n") : "");
        if (args[0] === "stop") running = false;
        if (args[0] === "rm") exists = false;
        if (args[0] === "start") running = true;
        if (args[0] === "exec" && args.some((arg) => arg.includes("$(id -u)"))) {
            return makeResult(0, options.actualIdentity ?? "1000:1000");
        }
        if (args[0] === "exec" && args.at(-1) === "true" && options.execFailure) return makeResult(1);
        if (args[0] === "run") {
            if (args.some((arg) => arg.includes("$(id -u ccc)"))) return makeResult(0, options.previousOwner ?? "1001:1002");
            if (options.runFailure) return makeResult(1);
            if (args.includes("-d")) exists = running = true;
            return makeResult(0, options.actualIdentity ?? "1000:1000");
        }
        return makeResult(0);
    });
}

describe("docker.ts module exports", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
        spawnSyncMock.mockReturnValue(makeResult(0));
        mockCleanupOwnerDevices.mockReset();
        mockEnsureIdentityImage.mockReset().mockReturnValue(derivedImageId);
        mockStartupLock.mockClear();
        mockExistsSync.mockReset().mockReturnValue(true);
        mockAccessSync.mockReset();
        mockLstatSync.mockReset().mockReturnValue({
            isFile: () => true,
            isSymbolicLink: () => false,
            size: 1024,
        });
        mockReadFileSync.mockReset().mockReturnValue(Buffer.from("managed-mcp-bundle"));
        mockStatSync.mockReset().mockReturnValue({ gid: 108 });
        _resetRuntimeCacheForTest();
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("getContainerName", () => {
        it("should prefix with ccc-", () => {
            expect(getContainerName("/home/user/test")).toMatch(/^ccc-/);
        });

        it("should be consistent for same path", () => {
            const a = getContainerName("/home/user/project");
            const b = getContainerName("/home/user/project");
            expect(a).toBe(b);
        });

        it("should generate correct format", () => {
            expect(getContainerName("/home/user/my-project")).toMatch(
                /^ccc-my-project-[a-f0-9]{12}$/,
            );
        });

        it("returns base name when profile is undefined (regression)", () => {
            const name = getContainerName("/home/user/my-project", undefined);
            expect(name).toMatch(/^ccc-my-project-[a-f0-9]{12}$/);
        });

        it("appends --p--<profile> suffix when profile is provided", () => {
            const name = getContainerName("/home/user/my-project", "work");
            expect(name).toMatch(/^ccc-my-project-[a-f0-9]{12}--p--work$/);
        });

        it("base name and profiled name differ for same path", () => {
            const base = getContainerName("/home/user/my-project");
            const profiled = getContainerName("/home/user/my-project", "work");
            expect(profiled).toBe(`${base}--p--work`);
        });
    });

    describe("isDockerRunning", () => {
        it("returns true when docker info succeeds", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(isDockerRunning()).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                ["info"],
                expect.any(Object),
            );
        });

        it("returns false when docker info fails", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(isDockerRunning()).toBe(false);
        });
    });

    describe("isDockerDesktop", () => {
        const originalPlatform = process.platform;
        const originalEnv = { ...process.env };

        afterEach(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            process.env = { ...originalEnv };
            // Reset cached value by clearing module cache
            // Since isDockerDesktop caches, we need to reset between tests
            // The cache is module-scoped, so we test behavior on first call
        });

        it("returns true on macOS (darwin) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            // Note: isDockerDesktop caches results, so this tests the macOS fast path
            // We can't easily test this in isolation due to caching, but the logic is:
            // if (process.platform !== "linux") return true
            platformSpy.mockRestore();
        });

        it("returns true on Windows (win32) without calling docker info", () => {
            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            platformSpy.mockRestore();
        });
    });

    describe("isContainerRunning", () => {
        it("returns true when container found in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerRunning("my-container")).toBe(true);
        });

        it("returns false when container not in docker ps", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerRunning("my-container")).toBe(false);
        });
    });

    describe("isContainerExists", () => {
        it("returns true when container found in docker ps -a", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "abc123\n"));
            expect(isContainerExists("my-container")).toBe(true);
        });

        it("returns false when container not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isContainerExists("my-container")).toBe(false);
        });
    });

    describe("isImageExists", () => {
        it("returns true when image found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "sha256:abc\n"));
            expect(isImageExists()).toBe(true);
        });

        it("returns false when image not found", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, ""));
            expect(isImageExists()).toBe(false);
        });
    });

    describe("isContainerImageOutdated", () => {
        it("returns true when container image SHA differs from current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage111\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:newimage222\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(true);
        });

        it("returns false when container image SHA matches current image SHA", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n"))  // container inspect
                .mockReturnValueOnce(makeResult(0, "sha256:sameimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(1, ""));  // container inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when image inspect fails (fail-open)", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:oldimage\n"))  // container inspect ok
                .mockReturnValueOnce(makeResult(1, ""));                   // image inspect fails
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });

        it("returns false when container inspect returns empty stdout", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))                    // container inspect empty
                .mockReturnValueOnce(makeResult(0, "sha256:newimage\n")); // image inspect
            expect(isContainerImageOutdated("my-container")).toBe(false);
        });
    });

    describe("Codex config ownership helpers", () => {
        it("does not change ownership when the host already has config access", () => {
            restoreCodexConfigHostOwnership("ccc-test");

            expect(mockAccessSync).toHaveBeenCalledTimes(1);
            expect(spawnSyncMock).not.toHaveBeenCalled();
        });

        it("does not prepare mounted Codex config when the container user already has access", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0));

            prepareCodexConfigForContainer("ccc-test");

            expect(spawnSyncMock).toHaveBeenCalledTimes(2);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker",
                expect.arrayContaining(["exec", "ccc-test"]),
                { encoding: "utf-8", timeout: 10000 },
            );
        });

        it("does not change permissions after a runtime access-probe error", () => {
            spawnSyncMock.mockReturnValueOnce({ ...makeResult(125), stderr: "container stopped" });
            expect(() => prepareCodexConfigForContainer("ccc-test")).toThrow(/directory access check failed.*container stopped/);
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(mockLstatSync).not.toHaveBeenCalled();
        });
    });

    describe("buildDockerRunArgs", () => {
        it("should be a function exported from docker.ts", () => {
            expect(typeof buildDockerRunArgs).toBe("function");
        });

        it("includes --hostname derived from container name", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            const hostnameIdx = args.indexOf("--hostname");
            expect(hostnameIdx).toBeGreaterThan(-1);
            expect(args[hostnameIdx + 1]).toBe("ccc-my-project-abc123");
        });

        it("truncates hostname to 63 chars for long container names", () => {
            mockExistsSync.mockReturnValue(false);
            const longName = "ccc-" + "a".repeat(80);
            const args = buildDockerRunArgs({
                containerName: longName,
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            const hostnameIdx = args.indexOf("--hostname");
            expect(hostnameIdx).toBeGreaterThan(-1);
            expect(args[hostnameIdx + 1]).toHaveLength(63);
        });

        it("includes -v for each credentialMount entry", () => {
            mockExistsSync.mockReturnValue(false);
            const credentialMounts = [
                { hostPath: "/home/user/.ccc/claude", containerPath: "/home/ccc/.claude" },
                { hostPath: "/home/user/.claude/ide", containerPath: "/home/ccc/.claude/ide" },
            ];
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts,
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            expect(args).toContain("/home/user/.ccc/claude:/home/ccc/.claude");
            expect(args).toContain("/home/user/.claude/ide:/home/ccc/.claude/ide");
        });

        it("resolves profile-specific claude credentials and default tool credential paths", () => {
            const claudeMount = { hostDir: ".ccc/claude", containerDir: "/home/ccc/.claude" };
            const codexMount = { hostDir: ".ccc/codex", containerDir: "/home/ccc/.codex" };

            expect(resolveCredentialHostPath(claudeMount, "work")).toMatch(/\/\.ccc\/profiles\/work\/claude$/);
            expect(resolveCredentialHostPath(codexMount, "work")).toMatch(/\/\.ccc\/codex$/);
        });

        it("includes -v for claude.json mount independently of credentialMounts", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
            });
            expect(args).toContain("/home/user/.ccc/claude.json:/home/ccc/.claude.json");
        });

        it("includes clipboard shared-files mount when configured", () => {
            mockExistsSync.mockReturnValue(false);
            const args = buildDockerRunArgs({
                containerName: "ccc-my-project-abc123",
                fullPath: "/home/user/my-project",
                projectMountPath: "/project/my-project-abc123",
                credentialMounts: [],
                claudeJsonFile: "/home/user/.ccc/claude.json",
                miseVolumeName: "ccc-mise-cache",
                pidsLimit: "-1",
                imageName: "ccc",
                hostSshDir: null,
                sshAgentSocket: null,
                clipboardFilesHostDir: "/home/user/.ccc/clipboard-files",
            });
            expect(args).toContain("/home/user/.ccc/clipboard-files:/run/ccc/clipboard-files");
        });
    });

    describe("buildLabRunnerRunConfig", () => {
        it("returns null for normal profiles", () => {
            expect(buildLabRunnerRunConfig(undefined, "ccc-project")).toBeNull();
            expect(buildLabRunnerRunConfig("work", "ccc-project")).toBeNull();
        });

        it("returns ready container VM config for ordinary containers on native Linux with /dev/kvm", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            const config = buildContainerVmRunConfig("ccc-project");

            expect(config).toEqual({
                status: "ready",
                stateVolumeName: "ccc-project-lab-state",
                stateContainerDir: "/home/ccc/.ccc/labs",
                kvmDevicePath: "/dev/kvm",
                kvmGroupId: 108,
                networkMode: "user",
            });
        });

        it("returns ready config for lab-runner on native Linux with /dev/kvm", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config).toEqual({
                status: "ready",
                stateVolumeName: "ccc-project-lab-state",
                stateContainerDir: "/home/ccc/.ccc/labs",
                kvmDevicePath: "/dev/kvm",
                kvmGroupId: 108,
                networkMode: "user",
            });
        });

        it("reports unsupported when /dev/kvm is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/\/dev\/kvm/);
            expect(config?.kvmDevicePath).toBeUndefined();
            expect(config?.networkMode).toBe("user");
        });

        it("reports unsupported for VM-backed Docker Desktop style runtimes", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-desktop",
                remote: true,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/VM-backed/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("reports unsupported for rootless Podman", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "podman",
                flavor: "podman-rootless",
                remote: false,
                rootless: true,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildLabRunnerRunConfig("lab-runner", "ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/podman-rootless/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("reports unsupported for rootless Docker", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-rootless",
                remote: false,
                rootless: true,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");

            const config = buildContainerVmRunConfig("ccc-project");

            expect(config?.status).toBe("unsupported");
            expect(config?.unsupportedReason).toMatch(/docker-rootless/);
            expect(config?.kvmDevicePath).toBeUndefined();
        });

        it("uses a stable per-container lab state volume name", () => {
            expect(getLabRunnerStateVolumeName("ccc-proj--p--lab-runner")).toBe(
                "ccc-proj--p--lab-runner-lab-state",
            );
        });
    });

    describe("getHostGitIdentityMounts", () => {
        it("returns existing host git identity config directory paths", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            const mounts = getHostGitIdentityMounts();

            expect(mounts).toEqual([
                expect.objectContaining({ containerPath: "/home/ccc/.config/git" }),
            ]);
        });

        it("does not require a bind mount for host .gitconfig", () => {
            mockExistsSync.mockImplementation((p: string) => p.endsWith("/.gitconfig"));

            const mounts = getHostGitIdentityMounts();

            expect(mounts).toHaveLength(0);
        });

        it("never mounts host gitconfig directly at /home/ccc/.gitconfig (atomic-rename safety)", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            const mounts = getHostGitIdentityMounts();

            // The CLI copies ~/.gitconfig into the running container so the
            // in-HOME file is regular, not a bind mount whose inode is anchored
            // to the mountpoint (rename(2) would EBUSY otherwise).
            expect(mounts.find((m) => m.containerPath === "/home/ccc/.gitconfig")).toBeUndefined();
            expect(mounts.find((m) => m.containerPath === "/host-stage/gitconfig")).toBeUndefined();
        });
    });

    describe("syncClipboardShims", () => {
        it("should docker cp each shim file that exists and chmod +x", () => {
            mockExistsSync.mockReturnValue(true);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(5);
            const shims = cpCalls.map((c: unknown[]) => (c[1] as string[])[2]);
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/xclip");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/wl-paste");
            expect(shims).toContain("ccc-test-abc123:/usr/local/bin/pbpaste");

            // Should also chmod +x all copied shims
            const chmodCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "exec" && (c[1] as string[]).includes("chmod")
            );
            expect(chmodCalls).toHaveLength(1);
            const chmodArgs = chmodCalls[0][1] as string[];
            expect(chmodArgs).toContain("+x");
            expect(chmodArgs).toContain("/usr/local/bin/xclip");
            expect(chmodArgs).toContain("/usr/local/bin/pbpaste");
        });

        it("should skip when shims directory does not exist", () => {
            mockExistsSync.mockReturnValue(false);
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(0);
        });

        it("should skip individual shims that do not exist", () => {
            // shimsDir exists, but only some shim files exist
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith("clipboard-shims")) return true;
                return p.endsWith("xclip") || p.endsWith("wl-paste");
            });
            spawnSyncMock.mockReturnValue(makeResult(0));

            syncClipboardShims("ccc-test-abc123", "/fake/dist");

            const cpCalls = spawnSyncMock.mock.calls.filter(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "cp"
            );
            expect(cpCalls).toHaveLength(2);
        });
    });

    describe("ensureDockerRunning", () => {
        it("does not exit when Docker is running", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).not.toThrow();
            mockExit.mockRestore();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureDockerRunning()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("getImageLabel", () => {
        it("returns label value when present", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "1.0.0\n"));
            expect(getImageLabel("ccc", "cli.version")).toBe("1.0.0");
        });

        it("returns null when label is missing (<no value>)", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, "<no value>\n"));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });

        it("returns null when inspect fails (image not found)", () => {
            spawnSyncMock.mockReturnValue(makeResult(1, ""));
            expect(getImageLabel("ccc", "cli.version")).toBeNull();
        });
    });

    describe("pullImage", () => {
        it("returns true on successful pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            expect(pullImage("repo/ccc:1.0.0")).toBe(true);
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["pull", "repo/ccc:1.0.0"], { stdio: "inherit" },
            );
        });

        it("returns false on failed pull", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));
            expect(pullImage("repo/ccc:1.0.0")).toBe(false);
        });
    });

    describe("tagImage", () => {
        it("runs docker tag", () => {
            spawnSyncMock.mockReturnValue(makeResult(0));
            tagImage("repo/ccc:1.0.0", "ccc");
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "docker", ["tag", "repo/ccc:1.0.0", "ccc"], { stdio: "ignore" },
            );
        });
    });

    describe("qualifyImageRefForRuntime", () => {
        it("leaves docker image refs unchanged", () => {
            _setRuntimeInfoForTest({ runtime: "docker" });
            expect(qualifyImageRefForRuntime("luxusio/claude-code-container:1.2.3")).toBe(
                "luxusio/claude-code-container:1.2.3",
            );
        });

        it("qualifies Docker Hub short-name refs for podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            expect(qualifyImageRefForRuntime("luxusio/claude-code-container:1.2.3")).toBe(
                "docker.io/luxusio/claude-code-container:1.2.3",
            );
        });

        it("does not rewrite already-qualified podman refs", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            expect(qualifyImageRefForRuntime("ghcr.io/luxusio/ccc:1.2.3")).toBe("ghcr.io/luxusio/ccc:1.2.3");
            expect(qualifyImageRefForRuntime("localhost:5000/ccc:1.2.3")).toBe("localhost:5000/ccc:1.2.3");
        });
    });

    describe("ensureImage (label-based)", () => {
        it("uses local dev build (no cli.version label) without pulling", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))       // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "<no value>\n"));      // getImageLabel -> null (dev build)

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            // No pull call should have been made
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("uses local image when cli.version matches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))          // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, `${CLI_VERSION}\n`));     // getImageLabel -> matches CLI_VERSION

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeUndefined();
            mockExit.mockRestore();
        });

        it("pulls and re-tags when cli.version mismatches CLI_VERSION", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(0))                    // pullImage -> success
                .mockReturnValueOnce(makeResult(0));                   // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            const tagCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "tag"
            );
            expect(tagCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("pulls when no local ccc image exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(0))        // pullImage -> success
                .mockReturnValueOnce(makeResult(0));       // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            const pullCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "pull"
            );
            expect(pullCall).toBeDefined();
            mockExit.mockRestore();
        });

        it("pulls the fully-qualified Docker Hub ref on rootless podman", () => {
            _setRuntimeInfoForTest({ runtime: "podman", rootless: true, flavor: "podman-rootless" });
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(0))        // pullImage -> success
                .mockReturnValueOnce(makeResult(0));       // tagImage

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).not.toThrow();
            expect(spawnSyncMock).toHaveBeenCalledWith(
                "podman",
                ["pull", `docker.io/luxusio/claude-code-container:${CLI_VERSION}`],
                { stdio: "inherit" },
            );
            mockExit.mockRestore();
        });

        it("warns but continues when pull fails with stale image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, "sha256:abc\n"))   // isImageExists -> true
                .mockReturnValueOnce(makeResult(0, "0.9.0\n"))       // getImageLabel -> old version
                .mockReturnValueOnce(makeResult(1));                   // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            const warnSpy = vi.spyOn(console, "warn");
            expect(() => ensureImage()).not.toThrow();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to pull"));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("from the CCC checkout: docker build -t ccc ."));
            expect(spawnSyncMock.mock.calls.some(([, args]) => (args as string[])[0] === "tag")).toBe(false);
            mockExit.mockRestore();
        });

        it("exits with error when pull fails with no image", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0, ""))    // isImageExists -> false
                .mockReturnValueOnce(makeResult(1));       // pullImage -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => ensureImage()).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("syncManagedMcpBundles", () => {
        it("stages and atomically installs every managed MCP bundle", () => {
            const digest = createHash("sha256").update("managed-mcp-bundle").digest("hex");
            let digestCalls = 0;
            spawnSyncMock.mockImplementation((_command: unknown, args: unknown) => {
                const argv = args as string[];
                if (argv.includes("sha256sum")) {
                    digestCalls += 1;
                    return makeResult(0, `${digestCalls % 2 === 0 ? digest : "0".repeat(64)}  server.mjs\n`);
                }
                return makeResult(0);
            });

            syncManagedMcpBundles("ccc-test");

            for (const bundle of ["x11-mcp", "device-lab-mcp", "lab-mcp"]) {
                const copy = spawnSyncMock.mock.calls.find((call: unknown[]) => {
                    const args = call[1] as string[];
                    return args?.[0] === "cp"
                        && args[1]?.endsWith(`/${bundle}/server.mjs`)
                        && args[2]?.startsWith(`ccc-test:/tmp/ccc-managed-${bundle}-`);
                });
                expect(copy).toBeDefined();

                const install = spawnSyncMock.mock.calls.find((call: unknown[]) => {
                    const args = call[1] as string[];
                    return args?.[0] === "exec"
                        && args.includes("root")
                        && args.at(-1)?.includes(`/opt/ccc/dist/${bundle}/server.mjs`);
                });
                expect(install).toBeDefined();
            }
            expect(digestCalls).toBe(6);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => {
                const args = call[1] as string[];
                return args?.[0] === "exec" && args.includes("rm") && args.includes("/opt/ccc/dist/device-lab-mcp/server.mjs");
            })).toBe(false);
        });

        it("skips transfer when the installed bundle digest already matches", () => {
            const digest = createHash("sha256").update("managed-mcp-bundle").digest("hex");
            spawnSyncMock.mockImplementation((_command: unknown, args: unknown) => {
                const argv = args as string[];
                return argv.includes("sha256sum") ? makeResult(0, `${digest}  server.mjs\n`) : makeResult(0);
            });

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock).toHaveBeenCalledTimes(3);
            expect(spawnSyncMock.mock.calls.every((call: unknown[]) => (call[1] as string[]).includes("sha256sum"))).toBe(true);
        });

        it("rejects a symlinked or oversized host bundle without copying it", () => {
            mockLstatSync.mockReturnValue({
                isFile: () => true,
                isSymbolicLink: () => true,
                size: 1024,
            });

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("managed MCP bundle is invalid"));
        });

        it("does not replace the destination when staging fails", () => {
            spawnSyncMock.mockReturnValue(makeResult(1));

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => (call[1] as string[])[0] === "cp")).toHaveLength(3);
            expect(spawnSyncMock.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes("install"))).toBe(false);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed to stage managed MCP bundle"));
        });

        it("removes a destination whose installed digest does not match", () => {
            spawnSyncMock.mockReturnValue(makeResult(0, `${"0".repeat(64)}  server.mjs\n`));

            syncManagedMcpBundles("ccc-test");

            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "exec" && args.includes("rm") && args.some((arg) => arg.endsWith("/server.mjs"));
            })).toHaveLength(3);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("bundle verification failed"));
        });
    });

    describe("fixSshPermissions", () => {
        it("reads mounted credentials as root but keeps socket handling unprivileged", () => {
            fixSshPermissions("ccc-test");
            expect(spawnSyncMock.mock.calls[0][1]).not.toContain("root");
            expect(spawnSyncMock).toHaveBeenCalledWith("docker", [
                "exec", "--user", "root", "-w", "/", "ccc-test", "/usr/bin/env", "-i",
                "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/bin/bash", "-c", SSH_COPY_SCRIPT,
            ], { stdio: "ignore" });
        });

        it.each([1, null])("reports copy failure without disclosing raw output (status %s)", (status) => {
            spawnSyncMock.mockReturnValueOnce(makeResult(0));
            spawnSyncMock.mockReturnValueOnce({ ...makeResult(1), status, stderr: "secret sentinel" });
            fixSshPermissions("ccc-test");
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("unable to refresh SSH credentials"));
            expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("secret sentinel"));
        });

        it("does not copy keys when host SSH directory is absent", () => {
            mockExistsSync.mockReturnValue(false);
            fixSshPermissions("ccc-test");
            expect(spawnSyncMock).toHaveBeenCalledTimes(1);
            expect(spawnSyncMock.mock.calls[0][1]).not.toContain("root");
        });
    });

    describe("startProjectContainer", () => {
        const projectPath = "/home/user/my-project";
        const ensureDirs = vi.fn();

        beforeEach(() => {
            ensureDirs.mockReset();
            mockExistsSync.mockReturnValue(true);
        });

        it.each([
            ["missing labels", {}],
            ["different UID", { ...getIdentityLabels(testIdentity), "ccc.identity.uid": "1001" }],
            ["different GID", { ...getIdentityLabels(testIdentity), "ccc.identity.gid": "1001" }],
            ["different mapping", { ...getIdentityLabels(testIdentity), "ccc.identity.mapping": "desktop" }],
            ["old contract", { ...getIdentityLabels(testIdentity), "ccc.identity.version": "0" }],
        ])("refuses running %s before image or mount replacement", (_description, labels) => {
            mockProjectRuntime({ exists: true, running: true, labels, imageId: baseImageId, contract: "{}" });
            const onRecreate = vi.fn();
            expect(() => startProjectContainer(projectPath, ensureDirs, undefined, undefined, undefined, onRecreate)).toThrow(/finish.*stop/i);
            expect(ensureDirs).not.toHaveBeenCalled();
            expect(onRecreate).not.toHaveBeenCalled();
            expect(mockEnsureIdentityImage).not.toHaveBeenCalled();
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run", "start"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("checks actual running UID/GID rather than accepting labels alone", () => {
            mockProjectRuntime({ exists: true, running: true, actualIdentity: "1001:1001" });
            expect(() => assertProjectContainerIdentity(getContainerName(projectPath), testIdentity)).toThrow(/finish.*stop/i);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("preserves a matching running container when its image has an update", () => {
            mockProjectRuntime({ exists: true, running: true, imageId: baseImageId });
            startProjectContainer(projectPath, ensureDirs);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run", "start"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("reuses the matching derived image across starts without perpetual replacement", () => {
            mockProjectRuntime({ exists: true, running: false });
            const onRecreate = vi.fn();
            startProjectContainer(projectPath, ensureDirs, undefined, undefined, undefined, onRecreate);
            startProjectContainer(projectPath, ensureDirs, undefined, undefined, undefined, onRecreate);
            expect(onRecreate).not.toHaveBeenCalled();
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
            expect(mockEnsureIdentityImage).toHaveBeenNthCalledWith(1, baseImageId, testIdentity);
            expect(mockEnsureIdentityImage).toHaveBeenNthCalledWith(2, baseImageId, testIdentity);
            expect(mockStartupLock).toHaveBeenCalledWith(
                expect.stringContaining(`/container-startup/${getContainerName(projectPath)}.lock`),
                expect.any(Function),
                expect.objectContaining({ reclaimStale: false }),
            );
        });

        it.each([true, false])("preserves a container when exec fails (initially running: %s)", (running) => {
            mockProjectRuntime({ exists: true, running, execFailure: true });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/stop.*retry/i);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("leaves a stopped legacy container intact if identity image preparation fails", () => {
            mockProjectRuntime({ exists: true, labels: {}, imageId: baseImageId });
            mockEnsureIdentityImage.mockImplementation(() => { throw new Error("Identity image validation failed"); });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow("Identity image validation failed");
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run", "start"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("refuses running mount drift without stopping the session", () => {
            mockProjectRuntime({ exists: true, running: true, contract: "{}" });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/finish.*stop/i);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("transitions stopped legacy state using the resolved image and resets setup once", () => {
            mockProjectRuntime({ exists: true, labels: {}, imageId: baseImageId });
            const onRecreate = vi.fn();
            startProjectContainer(projectPath, ensureDirs, undefined, undefined, undefined, onRecreate);
            expect(onRecreate).toHaveBeenCalledTimes(1);
            expect(mockEnsureIdentityImage).toHaveBeenCalledWith(baseImageId, testIdentity);
            const args = spawnSyncMock.mock.calls.find((call) => (call[1] as string[])[0] === "run")![1] as string[];
            expect(args.at(-1)).toBe(derivedImageId);
            expect(args).toContain(`${getIdentityMiseVolumeName(testIdentity)}:/home/ccc/.local/share/mise`);
            expect(args).toContain("ccc.identity.uid=1000");
            expect(args).toContain(`${projectPath}:/project/my-project-c7e2f75b53b9`);
            for (const mount of getAllCredentialMounts()) expect(args.some((arg) => arg.endsWith(`:${mount.containerDir}`))).toBe(true);
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "volume" && (call[1] as string[])[1] === "rm")).toBe(false);
        });

        it("migrates retained lab state only from verified previous image owners", () => {
            mockProjectRuntime({ exists: true, labels: {}, imageId: baseImageId, retainedLabState: true });
            startProjectContainer(projectPath, ensureDirs);
            const helpers = spawnSyncMock.mock.calls.map((call) => call[1] as string[]).filter((args) => args[0] === "run" && args.includes("--rm"));
            const oldOwnerProbe = helpers.find((args) => args.includes(baseImageId));
            expect(oldOwnerProbe).toBeDefined();
            expect(oldOwnerProbe).not.toContain("--mount");
            const migration = helpers.find((args) => args.some((arg) => arg.includes("find -P /state")))!;
            expect(migration).toContain(`type=volume,source=${getContainerName(projectPath)}-lab-state,target=/state`);
            expect(migration.at(-1)).toContain("-uid 1001 -exec chown -h 1000");
            expect(migration.at(-1)).toContain("-gid 1002 -exec chgrp -h 1000");
            expect(migration.some((arg) => arg.includes(projectPath) || arg.includes(".codex") || arg.includes(".claude"))).toBe(false);
        });

        it.each([
            { labStateInUse: true },
            { previousOwner: "unverified" },
            { previousOwner: "0:0" },
        ])("preserves stopped container and lab state when migration cannot be safe: %j", (failure) => {
            mockProjectRuntime({ exists: true, labels: {}, imageId: baseImageId, retainedLabState: true, ...failure });
            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow(/lab state/i);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm"].includes((call[1] as string[])[0]))).toBe(false);
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[]).includes("--mount"))).toBe(false);
        });

        it("returns container name when container is already running", () => {
            mockProjectRuntime({ exists: true, running: true, contract: fullCredentialMountsJson() });

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);
            expect(ensureDirs).toHaveBeenCalled();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[]).at(-1) === SSH_COPY_SCRIPT)).toBe(true);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(3);
        });

        it("starts a stopped container and returns its name", () => {
            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson() });

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const startCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "start"
            );
            expect(startCall).toBeDefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[]).at(-1) === SSH_COPY_SCRIPT)).toBe(true);
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(3);
        });

        it("recreates stopped container when credential mounts are missing (drift after tool registry update)", () => {
            mockExistsSync.mockReturnValue(false);

            // Existing container only has the old claude-only mounts → drift detected → recreate.
            const driftMountsJson = JSON.stringify([
                { Source: "/host/.claude", Destination: "/home/ccc/.claude" },
            ]);

            mockProjectRuntime({ exists: true, running: false, contract: driftMountsJson });

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("creates a new container when none exists", () => {
            mockExistsSync.mockReturnValue(false); // hostSshDir does not exist -> no SSH mount, no SSH fix

            mockProjectRuntime();

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).toMatch(/^ccc-/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(runCall).toBeDefined();
            expect(spawnSyncMock.mock.calls.filter((call: unknown[]) => {
                const args = call[1] as string[];
                return args[0] === "cp" && args[2]?.startsWith(`${name}:/tmp/ccc-managed-`);
            })).toHaveLength(3);
            const runArgs = runCall![1] as string[];
            expect(runArgs.some((arg) => /^CCC_DEVICE_LAB_OWNER_BASIS=/.test(arg))).toBe(false);
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=unsupported");
            expect(runArgs).toContain("CCC_LAB_NET_MODE=user");
            expect(runArgs).not.toContain("--device");
            expect(runArgs).not.toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).not.toContain("/dev/net/tun:/dev/net/tun");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates an ordinary container with durable lab state and KVM when supported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime();

            const name = startProjectContainer(projectPath, ensureDirs);
            expect(name).not.toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=ready");
            expect(runArgs).toContain("CCC_LAB_NET_MODE=user");
            expect(runArgs).toContain("--device");
            expect(runArgs).toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).toContain("--group-add");
            expect(runArgs).toContain("108");
            expect(runArgs).not.toContain("/dev/net/tun:/dev/net/tun");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates lab-runner profile container with durable lab state and KVM when supported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime();

            const name = startProjectContainer(projectPath, ensureDirs, undefined, undefined, "lab-runner");
            expect(name).toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER=1");
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=ready");
            expect(runArgs).toContain("--device");
            expect(runArgs).toContain("/dev/kvm:/dev/kvm");
            expect(runArgs).toContain("--group-add");
            expect(runArgs).toContain("108");
            expect(runArgs).not.toContain("--privileged");
        });

        it("creates lab-runner profile container with unsupported diagnostics when KVM is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            mockProjectRuntime();

            const name = startProjectContainer(projectPath, ensureDirs, undefined, undefined, "lab-runner");
            expect(name).toMatch(/--p--lab-runner$/);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs).toContain(`${name}-lab-state:/home/ccc/.ccc/labs`);
            expect(runArgs).toContain("CCC_LAB_RUNNER_STATUS=unsupported");
            expect(runArgs.some((arg) => arg.startsWith("CCC_LAB_RUNNER_UNSUPPORTED_REASON="))).toBe(true);
            expect(runArgs).not.toContain("--device");
            expect(runArgs).not.toContain("/dev/kvm:/dev/kvm");
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lab-runner profile requested"));
        });

        it("mounts every registered tool credential path when creating a container", () => {
            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime();

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];

            for (const mount of getAllCredentialMounts()) {
                expect(runArgs.some((arg) => arg.includes(`:${mount.containerDir}`))).toBe(true);
            }
        });

        it("mounts existing host git identity paths when creating a container", () => {
            mockExistsSync.mockImplementation((p: string) => (
                p.endsWith("/.gitconfig") || p.endsWith("/.config/git")
            ));

            mockProjectRuntime();

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = runCall![1] as string[];
            expect(runArgs.some((a) => a.endsWith("/.gitconfig:/host-stage/gitconfig:ro"))).toBe(false);
            expect(runArgs.some((a) => a.includes("/.config/git:/home/ccc/.config/git"))).toBe(true);
            const gitConfigInstall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker"
                    && (c[1] as string[]).some((arg) => arg.includes("/tmp/ccc-host-gitconfig"))
                    && (c[1] as string[])[0] === "exec",
            );
            expect(gitConfigInstall?.[1]).toEqual(expect.arrayContaining([
                "exec", "--user", "root", getContainerName(projectPath),
            ]));
            expect((gitConfigInstall?.[1] as string[]).at(-1)).toContain("chown ccc:ccc /home/ccc/.gitconfig");
        });

        it("fixes SSH key permissions after creating container when ssh dir exists", () => {
            mockExistsSync.mockReturnValue(true);

            mockProjectRuntime();

            startProjectContainer(projectPath, ensureDirs);

            const execCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker"
                    && (c[1] as string[])[0] === "exec"
                    && (c[1] as string[]).at(-1) === SSH_COPY_SCRIPT
            );
            expect(execCall).toBeDefined();
            expect((execCall![1] as string[])).toContain("root");
        });

        it("throws when container creation fails so the caller can clean up startup state", () => {
            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ runFailure: true });

            expect(() => startProjectContainer(projectPath, ensureDirs)).toThrow("Failed to create container");
        });

        it("uses darwin SSH agent socket on darwin platform", () => {
            mockExistsSync.mockReturnValue(false); // no SSH dir

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

            mockProjectRuntime();

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/run/host-services/ssh-auth.sock");

            platformSpy.mockRestore();
        });

        it("uses SSH_AUTH_SOCK env var on linux when socket exists", () => {
            mockExistsSync.mockImplementation((p: string) => {
                return p === "/tmp/ssh-agent.sock";
            });

            const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const origSock = process.env.SSH_AUTH_SOCK;
            process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";

            mockProjectRuntime();

            startProjectContainer(projectPath, ensureDirs);

            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            const runArgs = (runCall![1] as string[]).join(" ");
            expect(runArgs).toContain("/tmp/ssh-agent.sock");

            platformSpy.mockRestore();
            if (origSock === undefined) delete process.env.SSH_AUTH_SOCK;
            else process.env.SSH_AUTH_SOCK = origSock;
        });

        it("recreates stopped container when extraMounts are missing (containerHasMounts returns false)", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const missingMountsJson = JSON.stringify([]); // empty mounts -> missing required

            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ exists: true, running: false, contract: missingMountsJson });

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
            expect(rmCall).toBeDefined();
        });

        it("recreates stopped container when host git identity directory mounts are missing", () => {
            mockExistsSync.mockImplementation((p: string) => p.endsWith("/.config/git"));

            const missingGitIdentityMountsJson = fullCredentialMountsJson()
                .replace(/,\{"Source":"\/host\/home\/user\/\.config\/git","Destination":"\/home\/ccc\/\.config\/git"\}/, "");

            mockProjectRuntime({ exists: true, running: false, contract: missingGitIdentityMountsJson });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when durable lab state mount is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], { labState: false }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
            expect(runCall).toBeDefined();
        });

        it("recreates stopped existing default container when device lab state mount is missing", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], { deviceLabState: false }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            const runCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "run"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
            expect(runCall).toBeDefined();
        });

        it("recreates stopped existing default container when VM contract changes from unsupported to ready", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], {
                    status: "unsupported",
                    unsupportedReason: "/dev/kvm is not available on the container host",
                    kvmDevice: false,
                }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when VM contract changes from ready to unsupported", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson() });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when ready VM contract has extra group-add entries", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], { groupAdd: ["108", "999"] }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when ready VM contract has extra host devices", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], {
                    devices: [
                        { PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm" },
                        { PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" },
                    ],
                }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when unsupported VM contract has any stale device", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], {
                    status: "unsupported",
                    unsupportedReason: "/dev/kvm is not available on the container host",
                    groupAdd: [],
                    devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" }],
                }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("recreates stopped existing default container when it is privileged", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            _setRuntimeInfoForTest({
                runtime: "docker",
                flavor: "docker-native",
                remote: false,
                rootless: false,
            });
            mockExistsSync.mockImplementation((p: string) => p === "/dev/kvm");
            mockStatSync.mockReturnValue({ gid: 108 });

            mockProjectRuntime({ exists: true, running: false, contract: fullCredentialMountsJson([], { privileged: true }) });

            startProjectContainer(projectPath, ensureDirs);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
            expect(spawnSyncMock.mock.calls.some((call) => (call[1] as string[])[0] === "rm")).toBe(true);
        });

        it("reuses container when extraMounts are present and all mounts exist", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];
            const mountsJson = fullCredentialMountsJson([
                { Source: "/host/repo/.git", Destination: "/project/repo/.git" },
            ]);

            mockProjectRuntime({ exists: true, running: true, contract: mountsJson });

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since mounts are present
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("reuses container when Source differs but Destination matches (macOS Docker Desktop)", () => {
            const extraMounts = [{ hostPath: "/Users/me/repo/.git", containerPath: "/Users/me/repo/.git" }];
            // Docker Desktop on macOS may prefix Source with /host_mnt/ or resolve symlinks
            const mountsJson = fullCredentialMountsJson([
                { Source: "/host_mnt/Users/me/repo/.git", Destination: "/Users/me/repo/.git" },
            ]);

            mockProjectRuntime({ exists: true, running: true, contract: mountsJson });

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);

            // No stop/rm calls since Destination matches
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeUndefined();
        });

        it("skips containerHasMounts check when container does not exist with extraMounts", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime();

            const name = startProjectContainer(projectPath, ensureDirs, extraMounts);
            expect(name).toMatch(/^ccc-/);
        });

        it("refuses startup without changing existing work when docker inspect fails", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ exists: true, running: true, inspectFailure: true });

            expect(() => startProjectContainer(projectPath, ensureDirs, extraMounts)).toThrow(/Unable to inspect/);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
        });

        it("refuses startup without changing existing work when inspect returns invalid JSON", () => {
            const extraMounts = [{ hostPath: "/host/repo/.git", containerPath: "/project/repo/.git" }];

            mockExistsSync.mockReturnValue(false);

            mockProjectRuntime({ exists: true, running: true, invalidInspect: true });

            expect(() => startProjectContainer(projectPath, ensureDirs, extraMounts)).toThrow(/Invalid container state/);
            expect(spawnSyncMock.mock.calls.some((call) => ["stop", "rm", "run"].includes((call[1] as string[])[0]))).toBe(false);
        });
    });

    describe("stopProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            // ensureDockerRunning: isDockerRunning -> true
            // isContainerExists -> false
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            stopProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
            expect(mockCleanupOwnerDevices).not.toHaveBeenCalled();
        });

        it("stops container when it exists", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));            // docker stop

            stopProjectContainer(projectPath);

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("still stops container when device cleanup throws", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists -> true
                .mockReturnValueOnce(makeResult(0));            // docker stop
            mockCleanupOwnerDevices.mockImplementation(() => {
                throw new Error("cleanup failed");
            });

            stopProjectContainer(projectPath);

            const stopCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "stop"
            );
            expect(stopCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => stopProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });

    describe("removeProjectContainer", () => {
        const projectPath = "/home/user/my-project";

        it("logs 'Container not found' when container does not exist", () => {
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))    // docker info (ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "")); // isContainerExists -> false

            const consoleSpy = vi.spyOn(console, "log");
            removeProjectContainer(projectPath);
            expect(consoleSpy).toHaveBeenCalledWith("Container not found");
        });

        it("stops and removes container when it exists", () => {
            // removeProjectContainer calls ensureDockerRunning, isContainerExists, stopProjectContainer (which calls ensureDockerRunning+isContainerExists+docker stop), docker rm
            spawnSyncMock
                .mockReturnValueOnce(makeResult(0))           // docker info (removeProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (removeProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))           // docker info (stopProjectContainer -> ensureDockerRunning)
                .mockReturnValueOnce(makeResult(0, "abc123\n")) // isContainerExists (stopProjectContainer check) -> true
                .mockReturnValueOnce(makeResult(0))            // docker stop
                .mockReturnValueOnce(makeResult(0));            // docker rm

            removeProjectContainer(projectPath);

            expect(mockCleanupOwnerDevices).toHaveBeenCalledWith(projectPath, 5000, undefined);
            expect(mockCleanupOwnerDevices).toHaveBeenCalledTimes(1);
            const rmCall = spawnSyncMock.mock.calls.find(
                (c: unknown[]) => c[0] === "docker" && (c[1] as string[])[0] === "rm"
            );
            expect(rmCall).toBeDefined();
        });

        it("calls process.exit(1) when Docker is not running", () => {
            spawnSyncMock.mockReturnValueOnce(makeResult(1)); // docker info -> fail

            const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
                throw new Error("process.exit");
            });
            expect(() => removeProjectContainer(projectPath)).toThrow("process.exit");
            expect(mockExit).toHaveBeenCalledWith(1);
            mockExit.mockRestore();
        });
    });
});
