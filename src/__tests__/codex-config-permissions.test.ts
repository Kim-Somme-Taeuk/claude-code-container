import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, chownSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CODEX_CONFIG_FILE_ACL, codexConfigFileAclScript } from "../codex-config-acl.js";

const state = vi.hoisted(() => ({ home: "", spawn: vi.fn() }));
vi.mock("os", async (original) => ({
    ...await original<typeof import("os")>(),
    homedir: () => state.home,
}));
vi.mock("child_process", async (original) => ({
    ...await original<typeof import("child_process")>(),
    spawnSync: state.spawn,
}));
vi.mock("fs", async (original) => {
    const fs = await original<typeof import("fs")>();
    return { ...fs, accessSync: vi.fn(fs.accessSync), lstatSync: vi.fn(fs.lstatSync) };
});

const realFs = await vi.importActual<typeof import("fs")>("fs");
const realProcess = await vi.importActual<typeof import("child_process")>("child_process");
const access = vi.mocked(accessSync);
const lstat = vi.mocked(lstatSync);
const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
let configFile: string;
let configDir: string;
let restore: typeof import("../docker.js").restoreCodexConfigHostOwnership;
let prepare: typeof import("../docker.js").prepareCodexConfigForContainer;
let buildMcp: typeof import("../mcp-forward.js").buildMcpConfig;
let warning: ReturnType<typeof vi.spyOn>;
const userConfig = 'model = "test-model"\n[plugins."test@marketplace"]\nenabled = true\n';
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

beforeEach(async () => {
    vi.resetModules();
    state.home = mkdtempSync(join(tmpdir(), "ccc-config-access-"));
    configDir = join(state.home, ".ccc", "codex");
    configFile = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, userConfig, { mode: 0o600 });
    if (typeof process.getuid !== "function") {
        Object.defineProperty(process, "getuid", { value: () => realFs.statSync(configDir).uid, configurable: true });
    }
    access.mockReset().mockImplementation(realFs.accessSync);
    lstat.mockReset().mockImplementation(realFs.lstatSync);
    state.spawn.mockReset().mockImplementation((_cli, args: string[]) => ({ status: 0, stdout: args.at(-1) === "id -u" ? "2001\n" : "", stderr: "" }));
    warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await import("../container-runtime.js");
    runtime._setRuntimeInfoForTest({ runtime: "docker", cli: "docker", flavor: "docker-desktop", remote: true, rootless: false });
    restore = (await import("../docker.js")).restoreCodexConfigHostOwnership;
    prepare = (await import("../docker.js")).prepareCodexConfigForContainer;
    buildMcp = (await import("../mcp-forward.js")).buildMcpConfig;
});

afterEach(() => {
    vi.restoreAllMocks();
    if (getuidDescriptor) Object.defineProperty(process, "getuid", getuidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
    rmSync(state.home, { recursive: true, force: true });
});

it("leaves accessible config and its permission bits untouched", () => {
    chmodSync(configFile, 0o640);
    const originalMode = realFs.statSync(configFile).mode;
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(realFs.statSync(configFile).mode).toBe(originalMode);
    expect(readFileSync(configFile, "utf8")).toBe(userConfig);
});

it("does not repair a genuinely absent config", () => {
    rmSync(configFile);
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
});

it.each(["EACCES", "EPERM"])("repairs %s with both mapped ACL principals and verifies host access", (code) => {
    access.mockImplementationOnce(() => { throw Object.assign(denied(), { code }); });
    restore("ccc-test");
    expect(state.spawn).toHaveBeenCalledTimes(2);
    const args = state.spawn.mock.calls[1][1] as string[];
    expect(args.slice(0, 4)).toEqual(["exec", "--user", "root", "ccc-test"]);
    expect(args.at(-1)).toContain("host_uid = os.fstat(directory).st_uid");
    expect(args.at(-1)).toContain("principals = {host_uid, container_uid}");
    expect(args.at(-1)).toContain("python3 - 2001");
    expect(args.at(-1)).not.toMatch(/chown|chmod|setfacl/);
    expect(access).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
});

it("does not treat other filesystem errors as an ownership problem", () => {
    access.mockImplementationOnce(() => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); });
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("I/O failure"));
});

it("warns and skips repair when host identity is unavailable", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    // Model Windows, where the API itself is absent, not a throwing UID lookup.
    const original = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try { restore("ccc-test"); } finally {
        Object.defineProperty(process, "getuid", { value: original, configurable: true });
    }
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("identity is unavailable"));
});

it("uses the same mapped directory reference for rootless Podman", async () => {
    const runtime = await import("../container-runtime.js");
    runtime._setRuntimeInfoForTest({ runtime: "podman", flavor: "podman-rootless", rootless: true });
    access.mockImplementationOnce(() => { throw denied(); });
    restore("ccc-test");
    expect(state.spawn).toHaveBeenCalledWith("podman", expect.any(Array), expect.any(Object));
    const script = state.spawn.mock.calls[1][1].at(-1) as string;
    expect(script).toContain("host_uid = os.fstat(directory).st_uid");
    expect(script).not.toContain("chown");
    expect(warning).not.toHaveBeenCalled();
});

it("does not use a foreign-owned parent as the ownership reference", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    const parent = realFs.lstatSync(configDir);
    lstat.mockReturnValueOnce(Object.assign(parent, { uid: (process.getuid?.() ?? 0) + 1 }));
    restore("ccc-test");
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("owned by the host user"));
});

it("warns when parent metadata is inaccessible without attempting recursive repair", () => {
    access.mockImplementationOnce(() => { throw denied(); });
    lstat.mockImplementationOnce(() => { throw denied(); });
    expect(() => restore("ccc-test")).not.toThrow();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
});

it.each([
    { status: 1, stdout: "", stderr: "denied" },
    { status: null, error: new Error("runtime unavailable") },
])("warns when runtime repair fails and preserves the file", (result) => {
    access.mockImplementationOnce(() => { throw denied(); });
    state.spawn.mockImplementation((_cli, args: string[]) => args.at(-1) === "id -u" ? { status: 0, stdout: "2001\n" } : result);
    expect(() => restore("ccc-test")).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("container ACL repair failed"));
    expect(readFileSync(configFile, "utf8")).toBe(userConfig);
});

it("does not claim success when the host still lacks access", () => {
    access.mockImplementation(() => { throw denied(); });
    expect(() => restore("ccc-test")).not.toThrow();
    expect(access).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
});

describe.skipIf(process.platform === "win32")("Unix file types", () => {
    it.each(["config", "parent"])("does not follow a %s symlink", (target) => {
        const outside = join(state.home, "outside");
        if (target === "config") {
            writeFileSync(outside, "untouched");
            rmSync(configFile);
            symlinkSync(outside, configFile);
        } else {
            rmSync(configDir, { recursive: true });
            mkdirSync(outside);
            writeFileSync(join(outside, "config.toml"), "untouched");
            symlinkSync(outside, configDir);
        }
        access.mockImplementationOnce(() => { throw denied(); });
        restore("ccc-test");
        expect(state.spawn).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalled();
    });

    it("refuses a directory in place of the config file", () => {
        rmSync(configFile);
        mkdirSync(configFile);
        access.mockImplementationOnce(() => { throw denied(); });
        restore("ccc-test");
        expect(state.spawn).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalled();
    });

    it("rechecks file type inside the runtime before changing metadata", () => {
        const outside = join(state.home, "outside");
        writeFileSync(outside, "untouched", { mode: 0o400 });
        access.mockImplementationOnce(() => { throw denied(); });
        state.spawn.mockImplementation((_cli, args: string[]) => {
            if (args.at(-1) === "id -u") return { status: 0, stdout: "2001\n" };
            rmSync(configFile);
            symlinkSync(outside, configFile);
            return realProcess.spawnSync("sh", ["-c", args.at(-1)!.replace("/home/ccc/.codex", configDir)], { encoding: "utf8" });
        });
        restore("ccc-test");
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("container ACL repair failed"));
        expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
    });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("real host EACCES regression", () => {
    it("restores access inside the MCP writer lock after an intervening permission handoff", () => {
        restore("ccc-test");
        chmodSync(configFile, 0);
        const lockFile = join(state.home, ".ccc", "codex-config.lock");
        buildMcp(undefined, () => {
            expect(realFs.existsSync(lockFile)).toBe(true);
            expect(() => readFileSync(configFile, "utf8")).toThrow(expect.objectContaining({ code: "EACCES" }));
            chmodSync(configFile, 0o600);
        });
        expect(readFileSync(configFile, "utf8")).toContain(userConfig.trim());
        expect(readFileSync(configFile, "utf8")).toContain("# ccc-managed-mcp begin");
        expect(realFs.existsSync(lockFile)).toBe(false);
    });

    it.skipIf(process.platform !== "linux")("recovers before real MCP generation without changing owner or losing user/plugin config", () => {
        // A distinct supplementary group proves repair preserves group identity,
        // not just the mode bits (chown --reference would replace this group).
        const alternateGroup = process.getgroups?.().find((gid) => gid !== realFs.statSync(configDir).gid);
        if (alternateGroup !== undefined) chownSync(configFile, process.getuid!(), alternateGroup);
        const originalGroup = realFs.statSync(configFile).gid;
        const originalOwner = realFs.statSync(configFile).uid;
        chmodSync(configFile, 0o040);
        expect(() => readFileSync(configFile, "utf8")).toThrow(expect.objectContaining({ code: "EACCES" }));
        expect(() => buildMcp()).toThrow(/Unable to read Codex config.*EACCES/);
        state.spawn.mockImplementation((_cli, args: string[]) => {
            const script = args.at(-1)!.replace("/home/ccc/.codex", configDir);
            return realProcess.spawnSync("sh", ["-c", script], { encoding: "utf8" });
        });
        restore("ccc-test");
        expect(warning).not.toHaveBeenCalled();
        expect(() => realFs.accessSync(configFile, constants.R_OK | constants.W_OK)).not.toThrow();
        expect(realFs.statSync(configFile).mode & 0o777).toBe(0o640);
        expect(realFs.statSync(configFile).gid).toBe(originalGroup);
        expect(realFs.statSync(configFile).uid).toBe(originalOwner);
        buildMcp();
        const merged = readFileSync(configFile, "utf8");
        expect(merged).toContain(userConfig.trim());
        expect(merged).toContain("# ccc-managed-mcp begin");
        buildMcp();
        expect(readFileSync(configFile, "utf8")).toBe(merged);
        restore("ccc-test");
        expect(state.spawn).toHaveBeenCalledTimes(2);
    });

    it("keeps unresolved access failure fatal at MCP generation, without overwriting config", () => {
        chmodSync(configFile, 0);
        state.spawn.mockReturnValue({ status: 1, stdout: "", stderr: "denied" });
        expect(() => restore("ccc-test")).not.toThrow();
        expect(warning).toHaveBeenCalled();
        expect(() => buildMcp()).toThrow(/Unable to read Codex config.*EACCES/);
        chmodSync(configFile, 0o600);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });
});

describe("container credential preparation", () => {
    const scripts = () => state.spawn.mock.calls.map(([, args]) => (args as string[]).at(-1)!);
    const result = (status = 0, stdout = "", stderr = "") => ({ status, stdout, stderr });
    const isDirectoryProbe = (script: string) => script.includes('[ -x "$dir" ]');
    const isConfigProbe = (script: string) => script.includes('[ ! -e "$file" ]');
    const isGrant = (script: string) => script.includes("acl=$(getfacl");
    const simulate = (overrides: (script: string) => ReturnType<typeof result> | undefined = () => undefined) => {
        let checkedDirectory = false;
        state.spawn.mockImplementation((_cli, args: string[]) => {
            const script = args.at(-1)!;
            const override = overrides(script);
            if (override) return override;
            if (script === "id -u") return result(0, "2001\n");
            if (isDirectoryProbe(script) && !checkedDirectory) {
                checkedDirectory = true;
                return result(1);
            }
            return result();
        });
    };

    it("leaves healthy directory/config metadata alone and probes the directory first", () => {
        prepare("ccc-test");
        expect(state.spawn).toHaveBeenCalledTimes(2);
        expect(isDirectoryProbe(scripts()[0])).toBe(true);
        expect(isConfigProbe(scripts()[1])).toBe(true);
        expect(lstat).not.toHaveBeenCalled();
        expect(state.spawn.mock.calls.every(([, args]) => !args.includes("--user"))).toBe(true);
    });

    it("grants the actual container user parent access even when config is absent", () => {
        rmSync(configFile);
        chmodSync(configDir, 0o700);
        simulate();
        prepare("ccc-test");
        const grant = scripts().find(isGrant)!;
        expect(grant).toContain('setfacl -m "u:2001:rwx" -- "$dir"');
        expect(grant).not.toMatch(/setfacl[^;]*(-R|-d|--default)|chown|chmod/);
        expect(scripts().filter(isDirectoryProbe)).toHaveLength(2);
        expect(scripts().findIndex(isConfigProbe)).toBeGreaterThan(scripts().findIndex(isGrant));
        expect(scripts().some((script) => script.includes("apt-get"))).toBe(false);
        expect(realFs.statSync(configDir).uid).toBe(process.getuid!());
    });

    it("provisions missing ACL tools with bounded time only for a needed directory repair", () => {
        simulate((script) => script.includes("command -v getfacl") ? result(1) : undefined);
        const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
        prepare("ccc-test");
        const install = state.spawn.mock.calls.find(([, args]) => args.at(-1).includes("apt-get"))!;
        expect(install[1]).toContain("root");
        expect(install[1].at(-1)).toContain("timeout 90 sh -c");
        expect(install[1].at(-1)).toContain("install -y --no-install-recommends acl");
        expect(install[2].timeout).toBe(100000);
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Installing ACL tools"));
    });

    it.each(["installation", "grant", "verification"])("reports a directory %s failure before config handoff", (failure) => {
        simulate((script) => {
            if (failure === "installation" && script.includes("command -v getfacl")) return result(1);
            if ((failure === "installation" && script.includes("apt-get"))
                || (failure === "grant" && isGrant(script))
                || (failure === "verification" && isDirectoryProbe(script))) {
                return result(1, "", "permission policy denied");
            }
            return undefined;
        });
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => prepare("ccc-test")).toThrow(/failed \(permission policy denied\)/);
        expect(scripts().some(isConfigProbe)).toBe(false);
    });

    it("does not mistake a timed-out probe for a permission denial", () => {
        state.spawn.mockReturnValue({ status: null, error: new Error("spawn ETIMEDOUT") });
        expect(() => prepare("ccc-test")).toThrow(/directory access check failed.*ETIMEDOUT/);
        expect(state.spawn).toHaveBeenCalledOnce();
        expect(lstat).not.toHaveBeenCalled();
    });

    it("rejects a foreign-owned parent before any privileged command", () => {
        simulate();
        lstat.mockReturnValueOnce(Object.assign(realFs.lstatSync(configDir), { uid: process.getuid!() + 1 }));
        expect(() => prepare("ccc-test")).toThrow(/owned by the host user/);
        expect(state.spawn).toHaveBeenCalledOnce();
    });

    it("rejects unavailable host identity before repair", () => {
        simulate();
        Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
        expect(() => prepare("ccc-test")).toThrow(/host user identity is unavailable/);
        expect(state.spawn).toHaveBeenCalledOnce();
    });

    it("rejects malformed runtime UID without interpolating it into a privileged command", () => {
        simulate((script) => script === "id -u" ? result(0, "2001; touch /tmp/unsafe") : undefined);
        expect(() => prepare("ccc-test")).toThrow(/invalid container user identity/);
        expect(scripts().some(isGrant)).toBe(false);
        expect(state.spawn.mock.calls.every(([, args]) => !args.includes("--user"))).toBe(true);
    });

    it("grants both users config access without ownership or mode fallback", () => {
        let configChecks = 0;
        simulate((script) => {
            if (isDirectoryProbe(script)) return result();
            if (isConfigProbe(script)) return result(configChecks++ === 0 ? 1 : 0);
            return undefined;
        });
        prepare("ccc-test");
        const grant = scripts().find((script) => script.includes("os.setxattr"))!;
        expect(grant).toContain("python3 - 2001");
        expect(grant).toContain("os.O_NOFOLLOW");
        expect(grant).not.toMatch(/chown|chmod|setfacl/);
        expect(scripts().some(isGrant)).toBe(false);
        expect(configChecks).toBe(2);
    });

    it.each(["grant", "verification"])("fails explicitly when config %s fails", (failure) => {
        simulate((script) => {
            if (isDirectoryProbe(script)) return result();
            if (isConfigProbe(script)) return result(1, "", "config still denied");
            if (failure === "grant" && script.includes("os.setxattr")) return result(1, "", "config still denied");
            return undefined;
        });
        expect(() => prepare("ccc-test")).toThrow(new RegExp(`config ${failure === "grant" ? "ACL grant" : "access verification"} failed.*config still denied`));
    });

    describe.skipIf(process.platform === "win32")("native guarded repair scripts", () => {
        it.each(["parent", "config"])("rejects a %s symlink with a denied parent before any repair", (target) => {
            const outside = join(state.home, "outside");
            if (target === "parent") {
                rmSync(configDir, { recursive: true });
                mkdirSync(outside, { mode: 0o700 });
                symlinkSync(outside, configDir);
            } else {
                writeFileSync(outside, "untouched", { mode: 0o400 });
                rmSync(configFile);
                symlinkSync(outside, configFile);
                chmodSync(configDir, 0o700);
            }
            simulate();
            expect(() => prepare("ccc-test")).toThrow(/non-symlink/);
            expect(state.spawn).toHaveBeenCalledOnce();
        });

        it("installs missing ACL utilities after the real sh availability probe", () => {
            const emptyPath = join(state.home, "empty-path");
            mkdirSync(emptyPath);
            simulate((script) => script.includes("command -v getfacl")
                ? realProcess.spawnSync("/bin/sh", ["-c", script], {
                    encoding: "utf8", env: { ...process.env, PATH: emptyPath },
                }) : undefined);
            vi.spyOn(console, "error").mockImplementation(() => {});

            expect(() => prepare("ccc-test")).not.toThrow();
            expect(scripts().some((script) => script.includes("install -y --no-install-recommends acl"))).toBe(true);
        });

        it.each([
            "user:3000:rwx\nmask::---\n",
            "group:3000:rwx\nmask::r--\n",
            "mask::rwx\n",
            "default:user::rwx\ndefault:group::---\ndefault:other::---\n",
        ])("rejects complex ACL entries without running setfacl: %s", (extraAcl) => {
            const bin = join(state.home, "bin");
            mkdirSync(bin);
            const marker = join(state.home, "setfacl-called");
            // Only getfacl's output is simulated. Run the production guard shell
            // with real file types and verify it never invokes the mutator.
            writeFileSync(join(bin, "getfacl"), `#!/bin/sh\nprintf '%s\\n' 'user::rwx\ngroup::r-x\nother::r-x\n${extraAcl}'\n`, { mode: 0o755 });
            writeFileSync(join(bin, "setfacl"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
            simulate((script) => isGrant(script) ? realProcess.spawnSync("sh", ["-c", script.replace("/home/ccc/.codex", configDir)], {
                encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            }) : undefined);
            expect(() => prepare("ccc-test")).toThrow(/existing named, masked or default ACL requires manual inspection/);
            expect(realFs.existsSync(marker)).toBe(false);
            expect(realFs.statSync(configDir).mode & 0o777).toBe(0o755);
            expect(readFileSync(configFile, "utf8")).toBe(userConfig);
        });

        it("rechecks config type in the runtime before changing the target", () => {
            const outside = join(state.home, "outside");
            writeFileSync(outside, "untouched", { mode: 0o400 });
            simulate((script) => {
                if (isDirectoryProbe(script)) return result();
                if (isConfigProbe(script)) return result(1);
                if (script.includes("os.setxattr")) {
                    rmSync(configFile);
                    symlinkSync(outside, configFile);
                    return realProcess.spawnSync("sh", ["-c", script.replace("/home/ccc/.codex", configDir)], { encoding: "utf8" });
                }
                return undefined;
            });
            expect(() => prepare("ccc-test")).toThrow(/config ACL grant failed/);
            expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
            expect(readFileSync(outside, "utf8")).toBe("untouched");
        });
    });
});

describe.skipIf(process.platform !== "linux")("native config file ACL", () => {
    const undefinedId = 0xffffffff;
    type Entry = [number, number, number];
    const runPython = (script: string, ...args: string[]) => realProcess.spawnSync("python3", ["-c", script, ...args], { encoding: "utf8" });
    const grant = (prefix = "") => runPython(`${prefix}\n${CODEX_CONFIG_FILE_ACL.replace("/home/ccc/.codex", configDir)}`, "2001");
    const readAcl = (path = configFile): Entry[] | null => {
        const result = runPython(`import errno, json, os, struct, sys
try:
    data = os.getxattr(sys.argv[1], "system.posix_acl_access")
    print(json.dumps(list(struct.iter_unpack("<HHI", data[4:]))))
except OSError as error:
    if error.errno != errno.ENODATA: raise
    print("null")`, path);
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
    };
    const setAcl = (entries: Entry[]): void => {
        const result = runPython(`import json, os, struct, sys
os.setxattr(sys.argv[1], "system.posix_acl_access", struct.pack("<I", 2) + b"".join(
    struct.pack("<HHI", *entry) for entry in json.loads(sys.argv[2])))`, configFile, JSON.stringify(entries));
        expect(result.status, result.stderr).toBe(0);
    };
    const metadata = () => {
        const { uid, gid, mode } = realFs.statSync(configFile);
        return { uid, gid, mode };
    };

    it("adds shared access to an unreadable file, retaining owner execute, group rights and identities", () => {
        const original = metadata();
        chmodSync(configFile, 0o100);
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toEqual([
            [1, 7, undefinedId], [2, 6, 2001], [4, 0, undefinedId],
            [16, 6, undefinedId], [32, 0, undefinedId],
        ]);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it("preserves existing target execute and unrelated effective custom ACL rights", () => {
        setAcl([
            [1, 7, undefinedId], [2, 1, 2001], [2, 1, 3001], [4, 1, undefinedId],
            [8, 1, 3002], [16, 1, undefinedId], [32, 0, undefinedId],
        ]);
        const original = metadata();
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toEqual([
            [1, 7, undefinedId], [2, 7, 2001], [2, 1, 3001], [4, 1, undefinedId],
            [8, 1, 3002], [16, 7, undefinedId], [32, 0, undefinedId],
        ]);
    });

    it.each([
        [[1, 6, undefinedId], [2, 6, 3001], [4, 0, undefinedId], [16, 4, undefinedId], [32, 0, undefinedId]],
        [[1, 6, undefinedId], [4, 2, undefinedId], [16, 0, undefinedId], [32, 0, undefinedId]],
        [[1, 6, undefinedId], [4, 0, undefinedId], [8, 2, 3002], [16, 0, undefinedId], [32, 0, undefinedId]],
    ] as Entry[][])("refuses mask expansion that unmasks unrelated permissions: %j", (...entries: Entry[]) => {
        setAcl(entries);
        const original = metadata();
        const originalAcl = readAcl();
        const result = grant();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("mask expansion would grant unrelated access");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toEqual(originalAcl);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it.each(["getxattr", "setxattr"])("does not change mode or ownership when %s rejects unsupported ACLs", (operation) => {
        chmodSync(configFile, 0o640);
        const original = metadata();
        const result = grant(`import errno, os
def unsupported(*args):
    raise OSError(errno.ENOTSUP, "ACL filesystem unsupported")
os.${operation} = unsupported`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ACL filesystem unsupported");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toBeNull();
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it.each([
        "b'bad'",
        "struct.pack('<I', 3)",
        "struct.pack('<IHHI', 2, 1, 6, 0xffffffff)",
        "struct.pack('<I', 2) + struct.pack('<HHI', 1, 6, 0xffffffff) * 2",
        "struct.pack('<IHHI', 2, 2, 6, 0xffffffff)",
        "struct.pack('<IHHI', 2, 1, 8, 0xffffffff)",
    ])("rejects malformed ACL data without a mutation: %s", (data) => {
        const original = metadata();
        const result = grant(`import os, struct
os.getxattr = lambda *args: ${data}
def unexpected_write(*args):
    raise AssertionError("attempted ACL mutation")
os.setxattr = unexpected_write`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("malformed config ACL");
        expect(result.stderr).not.toContain("attempted ACL mutation");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toBeNull();
    });

    it("updates only the pinned inode when its path is replaced with a symlink", () => {
        const outside = join(state.home, "outside");
        const previous = join(configDir, "config.previous");
        writeFileSync(outside, "untouched", { mode: 0o400 });
        const result = grant(`import os
original_getxattr = os.getxattr
def replace_path(*args):
    os.rename(${JSON.stringify(configFile)}, ${JSON.stringify(previous)})
    os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(configFile)})
    return original_getxattr(*args)
os.getxattr = replace_path`);
        expect(result.status, result.stderr).toBe(0);
        expect(readAcl(previous)).toContainEqual([2, 6, 2001]);
        expect(readAcl(outside)).toBeNull();
        expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
    });

    it("regrants access after atomic file replacement without changing either owner", () => {
        expect(grant().status).toBe(0);
        const replacement = join(configDir, "replacement");
        writeFileSync(replacement, userConfig + "# replaced\n", { mode: 0o600 });
        realFs.renameSync(replacement, configFile);
        const original = metadata();
        expect(readAcl()).toBeNull();
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toContainEqual([2, 6, 2001]);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig + "# replaced\n");
    });
});

it.each(["", "-1", "4294967295", "2001; touch /tmp/unsafe"])("rejects unsafe or unmapped UID %j before building a privileged ACL script", (uid) => {
    expect(() => codexConfigFileAclScript(uid)).toThrow(/invalid container user identity/);
});
