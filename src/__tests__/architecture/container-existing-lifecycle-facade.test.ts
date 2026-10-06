import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerRestartRequiredError } from "../../container-restart-guidance.js";
import { createNativeContainerExistingLifecycle } from "../../composition/container-existing-lifecycle.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", () => ({ runtimeCli: native.runtime }));

const id = "a".repeat(64);
const name = "fixture-container";
type SuppliedPorts = Parameters<typeof createNativeContainerExistingLifecycle>[0];

function fixture(overrides: Partial<SuppliedPorts> = {}) {
    const order: string[] = [];
    const effect = (label: string): (() => undefined) => () => { order.push(label); };
    const ports: SuppliedPorts = {
        listContainer: vi.fn(() => ({ known: true, containerId: id })),
        identity: vi.fn(() => ({ containerId: id, running: false })),
        managedIdentity: vi.fn(() => ({ containerId: id, running: true })),
        assertProjectSources: effect("project"),
        assertDeviceSources: effect("device"),
        assertFilesystemSources: effect("filesystem"),
        inspectContract: vi.fn(() => true),
        safeToDefer: vi.fn(() => true),
        isRunning: vi.fn(() => true),
        canExec: vi.fn(() => true),
        canExecAfterBriefRetry: vi.fn(() => true),
        deviceSourcesMatch: vi.fn(() => true),
        syncMcp: effect("mcp"), fixSsh: effect("ssh"), syncGit: effect("git"),
        finish: vi.fn<SuppliedPorts["finish"]>((exactId) => { order.push(`finish:${exactId}`); }),
        ...overrides,
    };
    const destinations = vi.fn(() => ["/fixture/project", "/fixture/auth"]);
    const context = {
        startCli: "captured-runtime", requiredMountDestinations: destinations,
        projectPath: "/fixture/project", profile: "work",
    };
    return { order, ports, context, destinations, lifecycle: createNativeContainerExistingLifecycle(ports, context) };
}

describe("existing container application through native composition", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        native.runtime.mockReturnValue("podman");
        native.spawn.mockReturnValue({ status: 0 });
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("constructs without observations, runtime selection, subprocesses or presentation", () => {
        const f = fixture();
        expect(f.order).toEqual([]);
        for (const value of Object.values(f.ports)) {
            if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled();
        }
        expect(f.destinations).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("reuses exact identity through separate synchronization and the shared finish", () => {
        const f = fixture();
        expect(f.lifecycle.run({ containerName: name, debug: true })).toEqual({ kind: "joined", containerId: id });
        expect(f.order).toEqual(["project", "device", "filesystem", "project", "device", "filesystem", "mcp", "ssh", "git", `finish:${id}`]);
        expect(f.ports.canExec).toHaveBeenCalledExactlyOnceWith(id);
        expect(f.ports.canExecAfterBriefRetry).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledExactlyOnceWith(`[ccc:debug] Container ${name} has all required mounts`);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("uses captured runtime only for pinned restart, with inherited stdio", () => {
        const f = fixture({ isRunning: () => false });
        expect(f.lifecycle.run({ containerName: name, debug: true })).toEqual({ kind: "joined", containerId: id });
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("captured-runtime", ["start", id], { stdio: "inherit" });
        expect(native.runtime).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenNthCalledWith(2, `[ccc:debug] Container ${name} exists, restarting`);
        expect(f.order.slice(-4)).toEqual(["mcp", "ssh", "git", `finish:${id}`]);
    });

    it.each([{ status: 1 }, { status: null }, { status: 0, error: new Error("start denied") }])("refuses restart failure without synchronization/removal: %j", result => {
        native.spawn.mockReturnValue(result);
        const f = fixture({ isRunning: () => false });
        expect(() => f.lifecycle.run({ containerName: name })).toThrow("Stopped container could not be restarted; automatic replacement was refused.");
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(f.order).not.toContain("mcp");
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("recovers only an authorized managed exact ID, selecting stop/remove runtime separately", () => {
        native.runtime.mockReturnValueOnce("docker").mockReturnValueOnce("podman");
        const f = fixture({ inspectContract: () => false });
        const recreate = vi.fn(() => { f.order.push("recreated"); });
        const guard = vi.fn((replace: () => void) => { replace(); return true; });
        expect(f.lifecycle.run({ containerName: name, managedProjectPath: "/fixture/project", initiallyRunningContainerId: id, replacementGuard: guard, onRecreate: recreate })).toEqual({ kind: "continue-to-create" });
        expect(f.ports.managedIdentity).toHaveBeenCalledExactlyOnceWith(id, "/fixture/project");
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["stop", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
        ]);
        expect(console.log).toHaveBeenCalledExactlyOnceWith("Recreating container (container contract changed)...");
        expect(recreate).toHaveBeenCalledTimes(1);
        expect(f.ports.finish).not.toHaveBeenCalled();
        expect(f.ports.safeToDefer).not.toHaveBeenCalled();
    });

    it("uses ordinary non-force removal on the captured stopped path without stop or managed reinspection", () => {
        const f = fixture();
        expect(f.lifecycle.replace({ containerName: name, expectedContainerId: id, reason: "changed", replacementGuard: operation => { operation(); return true; } })).toBe(true);
        expect(native.spawn).toHaveBeenCalledExactlyOnceWith("podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        expect(f.ports.managedIdentity).not.toHaveBeenCalled();
    });

    it.each(["stop", "rm"] as const)("preserves native %s failure, suppressing later effects and callbacks", operation => {
        const f = fixture();
        native.spawn.mockImplementation((_cli, args) => ({ status: args[0] === operation ? 1 : 0 }));
        const recreated = vi.fn();
        expect(() => f.lifecycle.replace({ containerName: name, expectedContainerId: id, managedProjectPath: "/fixture/project", initiallyRunningContainerId: id, reason: "changed", replacementGuard: replace => { replace(); return true; }, onRecreate: recreated })).toThrow(operation === "stop"
            ? "Container replacement aborted because the idle running container could not be stopped."
            : "Container replacement aborted because the stopped container could not be removed.");
        expect(recreated).not.toHaveBeenCalled();
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(operation === "stop" ? ["stop"] : ["stop", "rm"]);
        expect(console.log).toHaveBeenCalledTimes(operation === "stop" ? 0 : 1);
    });

    it("preserves managed successor identity without native effects", () => {
        const f = fixture({ managedIdentity: () => ({ containerId: "successor", running: true }) });
        expect(f.lifecycle.replace({ containerName: name, expectedContainerId: id, managedProjectPath: "/fixture/project", initiallyRunningContainerId: id, reason: "changed", replacementGuard: replace => { replace(); return true; } })).toBe(false);
        expect(native.runtime).not.toHaveBeenCalled();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(console.log).not.toHaveBeenCalled();
    });

    it("reads required destinations only when reporting a mismatch and safely defers without MCP", () => {
        const f = fixture({ inspectContract: (_id, report) => { report("credential mount changed"); return false; } });
        f.destinations.mockReturnValue(["/updated/destination"]);
        expect(f.lifecycle.run({ containerName: name, debug: true, replacementGuard: () => false })).toEqual({ kind: "joined", containerId: id });
        expect(vi.mocked(console.error).mock.calls).toEqual([
            [`[ccc:debug] Container ${name} missing required mounts or VM run contract:`],
            ["[ccc:debug]   required destination: /updated/destination"],
        ]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith("[ccc] Container update deferred (credential mount changed) because the existing container is running. It will be applied after the container stops.");
        expect(f.order.slice(-3)).toEqual(["ssh", "git", `finish:${id}`]);
        expect(f.order).not.toContain("mcp");
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("throws the original restart-guidance class with runtime selected at the unsafe-defer point", () => {
        const f = fixture({ inspectContract: () => false, safeToDefer: (_id, report) => { report("unsafe project source"); return false; } });
        let failure: unknown;
        try { f.lifecycle.run({ containerName: name, replacementGuard: () => false }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(ContainerRestartRequiredError);
        expect(failure).toMatchObject({ name: "ContainerRestartRequiredError", reason: "unsafe project source", workspacePath: "/fixture/project", runtime: "podman", profile: "work" });
        expect(native.runtime).toHaveBeenCalledTimes(1);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(f.ports.finish).not.toHaveBeenCalled();
    });

    it("propagates shared finish failure after synchronization without a second join or recreation", () => {
        const failure = new Error("Container identity changed before session handoff; refusing to join.");
        const f = fixture({ finish: () => { throw failure; } });
        expect(() => f.lifecycle.run({ containerName: name })).toThrow(failure);
        expect(f.order.slice(-3)).toEqual(["mcp", "ssh", "git"]);
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("keeps repeated guarded replacement effects and false-after-success semantics", () => {
        const f = fixture();
        const callback = vi.fn();
        expect(f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => { replace(); replace(); return false; }, onRecreate: callback })).toBe(false);
        expect(native.spawn.mock.calls).toEqual([
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
            ["podman", ["rm", id], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }],
        ]);
        expect(callback).toHaveBeenCalledTimes(2);
    });

    it("does not fabricate rollback when recreation callback throws after successful removal", () => {
        const failure = new Error("caller refused after removal");
        const f = fixture();
        expect(() => f.lifecycle.replace({ containerName: name, reason: "changed", replacementGuard: replace => { replace(); return true; }, onRecreate: () => { throw failure; } })).toThrow(failure);
        expect(native.spawn).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls[0][1]).toEqual(["rm", id]);
    });
});
