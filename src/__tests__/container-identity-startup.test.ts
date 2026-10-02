import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "path";

const mocks = vi.hoisted(() => ({
    preflight: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    createLock: vi.fn(),
    removeLock: vi.fn(),
    setSession: vi.fn(),
    clearSession: vi.fn(),
    cleanupSession: vi.fn(),
    signalHandlers: vi.fn(),
    clipboard: vi.fn(),
    broker: vi.fn(),
    exists: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    spawn: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => ({
    ...await importOriginal<typeof import("fs")>(),
    existsSync: mocks.exists,
    mkdirSync: mocks.mkdir,
    writeFileSync: mocks.writeFile,
    unlinkSync: mocks.unlink,
}));
vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
    spawnSync: mocks.spawn,
}));
vi.mock("../docker.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../docker.js")>(),
    ensureDockerRunning: vi.fn(),
    assertProjectContainerIdentity: mocks.preflight,
    startProjectContainer: mocks.start,
    stopProjectContainer: mocks.stop,
    getContainerStatus: vi.fn(() => ({ exists: true, running: true, imageId: "legacy-image" })),
}));
vi.mock("../session.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../session.js")>(),
    createSessionLock: mocks.createLock,
    removeSessionLock: mocks.removeLock,
    setSession: mocks.setSession,
    clearSession: mocks.clearSession,
    cleanupSession: mocks.cleanupSession,
    setupSignalHandlers: mocks.signalHandlers,
}));
vi.mock("../clipboard-server.js", () => ({ ensureClipboardServer: mocks.clipboard }));
vi.mock("../device-lab-broker.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../device-lab-broker.js")>(),
    ensureHostDeviceBroker: mocks.broker,
}));
vi.mock("../worktree.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../worktree.js")>(),
    getWorktreeGitMounts: vi.fn(() => []),
}));

const { exec } = await import("../index.js");
const { getProjectId } = await import("../utils.js");
const { getContainerName } = await import("../docker.js");

describe("CLI identity startup failure isolation", () => {
    const projectPath = resolve("/fixture/project");
    const ownLock = "/fixture/locks/project--this-session.lock";
    const failure = new Error("Legacy container is running; finish its work and stop it before retrying");

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.preflight.mockReset();
        mocks.start.mockReset().mockImplementation(() => { throw failure; });
        mocks.createLock.mockReturnValue(ownLock);
        mocks.exists.mockReturnValue(true);
        mocks.clipboard.mockResolvedValue(null);
        mocks.broker.mockResolvedValue({ ok: true });
        mocks.spawn.mockImplementation(() => { throw new Error("Unexpected subprocess during rejected startup"); });
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it.each([undefined, "work"])("rejects a live legacy container before setup or session registration (profile %s)", async (profile) => {
        mocks.preflight.mockImplementation(() => { throw failure; });

        await expect(exec(projectPath, ["true"], {}, profile)).rejects.toBe(failure);

        expect(mocks.preflight).toHaveBeenCalledExactlyOnceWith(getContainerName(projectPath, profile));
        // The mise existence check, credential preparation, and clipboard setup
        // all occur after preflight, so none can run on refusal.
        expect(mocks.exists).not.toHaveBeenCalled();
        expect(mocks.mkdir).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.createLock).not.toHaveBeenCalled();
        expect(mocks.setSession).not.toHaveBeenCalled();
        expect(mocks.signalHandlers).not.toHaveBeenCalled();
        expect(mocks.clipboard).not.toHaveBeenCalled();
        expect(mocks.broker).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
        expect(mocks.removeLock).not.toHaveBeenCalled();
        expect(mocks.clearSession).not.toHaveBeenCalled();
        expect(mocks.cleanupSession).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each([undefined, "work"])("removes only this startup's lock when the locked recheck refuses (profile %s)", async (profile) => {
        await expect(exec(projectPath, ["true"], {}, profile)).rejects.toBe(failure);

        expect(mocks.preflight).toHaveBeenCalledExactlyOnceWith(getContainerName(projectPath, profile));
        expect(mocks.createLock).toHaveBeenCalledExactlyOnceWith(getProjectId(projectPath), profile);
        expect(mocks.setSession).toHaveBeenCalledExactlyOnceWith(ownLock, projectPath, profile, "command");
        expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
            projectPath, expect.any(Function), undefined,
            expect.stringMatching(/\/clipboard\.port$/), profile, expect.any(Function),
        );
        expect(mocks.removeLock).toHaveBeenCalledExactlyOnceWith(ownLock);
        expect(mocks.clearSession).toHaveBeenCalledTimes(1);
        expect(mocks.removeLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.clearSession.mock.invocationCallOrder[0]);
        expect(mocks.createLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
        expect(mocks.cleanupSession).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.unlink).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
