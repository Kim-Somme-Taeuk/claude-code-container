import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), filesystem: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(),
    spawnSync: native.spawn,
    spawn: () => { throw new Error("Forbidden fixture process"); },
    exec: () => { throw new Error("Forbidden fixture process"); },
    execFile: () => { throw new Error("Forbidden fixture process"); },
    fork: () => { throw new Error("Forbidden fixture process"); },
}));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const blocked = () => { native.filesystem(); throw new Error("Forbidden fixture filesystem effect"); };
    return {
        ...actual,
        readFileSync: (selected: unknown) => {
            if (selected instanceof URL && selected.href === new URL("../../../packages/device-lab/package.json", import.meta.url).href) {
                return JSON.stringify({ version: "0.0.0-fixture" });
            }
            return blocked();
        },
        existsSync: blocked, statSync: blocked, lstatSync: blocked, realpathSync: blocked,
        mkdirSync: blocked, writeFileSync: blocked, openSync: blocked, fstatSync: blocked,
        closeSync: blocked, rmSync: blocked, chmodSync: blocked, readdirSync: blocked,
        unlinkSync: blocked, renameSync: blocked, readSync: blocked,
    };
});
vi.mock("os", async original => ({
    ...await original<typeof import("node:os")>(),
    homedir: () => process.platform === "win32" ? "C:\\ccc-socket-fake\\home" : "/ccc-socket-fake/home",
}));

// Docker, application, native composition and runtime selection remain real.
const docker = await import("../../docker.js");
const runtime = await import("../../container-runtime.js");
const probeScript = 's=/var/run/docker.sock; [ -S "$s" ] || exit 0; [ -r "$s" ] && [ -w "$s" ] && exit 0; id -un; stat -c %g "$s"; exit 10';
const grantScript = 'u="$1"; g="$2"; n=$(getent group "$g" | cut -d: -f1); if [ -z "$n" ]; then if getent group ccc-host-socket >/dev/null; then groupmod -g "$g" ccc-host-socket; else groupadd -g "$g" ccc-host-socket; fi; n=ccc-host-socket; fi; usermod -aG "$n" "$u"';
const warning = "[ccc] Could not grant the container user access to the container-manager socket; docker commands inside the container may need sudo.";
const probeCall = (cli: string, target: string) => [cli, ["exec", target, "sh", "-c", probeScript], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
}];
const grantCall = (cli: string, target: string, user = "ccc", gid = "0") => [cli, [
    "exec", "--user", "root", target, "timeout", "-k", "2s", "8s", "sh", "-c", grantScript, "ccc-socket-grant", user, gid,
], { stdio: "ignore", timeout: 10_000 }];
function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}
beforeEach(() => {
    vi.resetAllMocks();
    runtime._setRuntimeInfoForTest({ runtime: "docker" });
    docker.resetContainerManagerSocketAccessWarningForTest();
    native.spawn.mockImplementation(() => { throw new Error("Unplanned fixture native command"); });
    vi.spyOn(console, "warn").mockImplementation(function (this: unknown) {
        expect(this).toBe(console);
        return undefined;
    });
});
afterEach(() => {
    expect(native.filesystem).not.toHaveBeenCalled();
    docker.resetContainerManagerSocketAccessWarningForTest();
    runtime._resetRuntimeCacheForTest();
    vi.restoreAllMocks();
});

describe("container socket access actual public facade", () => {
    it("preserves both literal native script exports", () => {
        expect(docker.CONTAINER_MANAGER_SOCKET_PROBE).toBe(probeScript);
        expect(docker.CONTAINER_MANAGER_SOCKET_GRANT).toBe(grantScript);
        expect(grantScript).not.toMatch(/\bch(mod|own|grp)\b/);
    });
    it.each(["docker", "podman"] as const)("dispatches exactly one default-user %s probe on success", cli => {
        runtime._setRuntimeInfoForTest({ runtime: cli });
        native.spawn.mockReturnValueOnce({ status: 0, get stdout(): unknown { throw new Error("unobserved stdout"); } });
        expect(docker.ensureContainerManagerSocketAccess("selected-target")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([probeCall(cli, "selected-target")]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it("keeps exact root grant arguments, options, leading-zero GID and first two output tokens", () => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: " \tubuntu\n00042 surplus output\n" })
            .mockReturnValueOnce({ status: 0 });
        expect(docker.ensureContainerManagerSocketAccess("pinned-id")).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "pinned-id"), grantCall("docker", "pinned-id", "ubuntu", "00042")]);
        expect(console.warn).not.toHaveBeenCalled();
    });
    it("selects the actual runtime separately at probe and grant dispatch", () => {
        native.spawn.mockImplementationOnce(() => {
            runtime._setRuntimeInfoForTest({ runtime: "podman", flavor: "podman-rootless", rootless: true });
            return { status: 10, stdout: "ccc 0" };
        }).mockReturnValueOnce({ status: 0 });
        docker.ensureContainerManagerSocketAccess("target");
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "target"), grantCall("podman", "target")]);
    });
    it.each([
        [1, "ccc 0"], [null, "ccc 0"], [10, "bad;user 0"], [10, "ccc 0x1"], [10, undefined],
    ])("warns once for probe status %s/output %s without privileged dispatch", (status, stdout) => {
        native.spawn.mockReturnValue({ status, stdout });
        docker.ensureContainerManagerSocketAccess("one");
        docker.ensureContainerManagerSocketAccess("two");
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "one"), probeCall("docker", "two")]);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
    });
    it("shares warning state across probe/grant failures and targets; reset has no native effects", () => {
        native.spawn.mockReturnValueOnce({ status: 10, stdout: "ccc 0" }).mockReturnValueOnce({ status: null })
            .mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 10, stdout: "ccc 0" }).mockReturnValueOnce({ status: 1 });
        docker.ensureContainerManagerSocketAccess("one"); docker.ensureContainerManagerSocketAccess("two");
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
        const previous = [...native.spawn.mock.calls];
        expect(docker.resetContainerManagerSocketAccessWarningForTest()).toBeUndefined();
        expect(native.spawn.mock.calls).toEqual(previous);
        docker.ensureContainerManagerSocketAccess("three");
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "one"), grantCall("docker", "one"), probeCall("docker", "two"), probeCall("docker", "three"), grantCall("docker", "three")]);
    });
    it("passes through unprojected native results and observes them in original order", () => {
        const trace: string[] = [];
        let reads = 0;
        native.spawn.mockImplementationOnce(() => { trace.push("probe"); return {
            get status() { trace.push(`status:${++reads}`); return reads === 1 ? 1 : 10; },
            get stdout() { trace.push("stdout"); return { toString() { trace.push("coerce"); return "ccc 0"; } }; },
            get error(): unknown { throw new Error("unobserved native error"); },
        }; }).mockImplementationOnce(() => { trace.push("grant"); return {
            get status() { trace.push("grant-status"); return 0; },
            get error(): unknown { throw new Error("unobserved native error"); },
        }; });
        docker.ensureContainerManagerSocketAccess("target");
        expect(trace).toEqual(["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status"]);
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "target"), grantCall("docker", "target")]);
    });
    const steps = ["probe", "status:1", "stdout", "coerce", "status:2", "grant", "grant-status", "warn"];
    it.each(steps)("preserves native/getter/console thrown identity at %s", step => {
        for (const failure of [new Error(step), { step }]) {
            docker.resetContainerManagerSocketAccessWarningForTest();
            native.spawn.mockReset();
            const trace: string[] = [];
            const visit = (name: string) => { trace.push(name); if (step === name) throw failure; };
            let reads = 0;
            native.spawn.mockImplementationOnce(() => { visit("probe"); return {
                get status() { visit(`status:${++reads}`); return 10; },
                get stdout() { visit("stdout"); return { toString() { visit("coerce"); return "ccc 0"; } }; },
            }; }).mockImplementationOnce(() => { visit("grant"); return { get status() { visit("grant-status"); return 1; } }; });
            vi.mocked(console.warn).mockImplementation(() => { visit("warn"); });
            expect(thrown(() => docker.ensureContainerManagerSocketAccess("target"))).toBe(failure);
            expect(trace).toEqual(steps.slice(0, steps.indexOf(step) + 1));
            expect(native.spawn.mock.calls).toEqual([probeCall("docker", "target"), ...(steps.indexOf(step) >= steps.indexOf("grant") ? [grantCall("docker", "target")] : [])]);
        }
    });
    it("uses live console receiver and suppresses reentrant/later warnings after console throws", () => {
        const failure = { warning: "failure" };
        native.spawn.mockReturnValue({ status: 1 });
        vi.mocked(console.warn).mockImplementation(function (this: unknown, message) {
            expect(this).toBe(console);
            expect(message).toBe(warning);
            docker.ensureContainerManagerSocketAccess("reentrant");
            throw failure;
        });
        expect(thrown(() => docker.ensureContainerManagerSocketAccess("outer"))).toBe(failure);
        expect(docker.ensureContainerManagerSocketAccess("later")).toBeUndefined();
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(native.spawn.mock.calls).toEqual([probeCall("docker", "outer"), probeCall("docker", "reentrant"), probeCall("docker", "later")]);
        docker.resetContainerManagerSocketAccessWarningForTest();
        vi.mocked(console.warn).mockImplementation(() => undefined);
        docker.ensureContainerManagerSocketAccess("reset");
        expect(console.warn).toHaveBeenCalledTimes(2);
    });
    it("ignores hostile values returned by a replaced live console warning", () => {
        native.spawn.mockReturnValue({ status: 1 });
        const ignored = { get then(): unknown { throw new Error("unobserved console return"); } };
        vi.mocked(console.warn).mockImplementation((() => ignored) as unknown as typeof console.warn);
        expect(docker.ensureContainerManagerSocketAccess("target")).toBeUndefined();
    });
});
