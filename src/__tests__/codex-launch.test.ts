import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transpileModule, ScriptTarget } from "typescript";
import { prepareCodexLaunch } from "../codex-launch.js";

const prefix = ["exec", "-w", "/project/with spaces", "--env-file", "/tmp/private-env", "ccc-fixture"];
const bypass = "--dangerously-bypass-approvals-and-sandbox";
function probe(status: number | null, stdout = "", extra = {}) {
    return { status, stdout, stderr: "", signal: null, ...extra };
}
function missingDaemon() { return probe(1, "ccc-codex-daemon-missing\n"); }
const startHelp = "Usage: codex app-server daemon start [OPTIONS]\n";
const ready = (command: string[]) => ({ ok: true, command });
function runner(...results: ReturnType<typeof probe>[]) {
    const mock = vi.fn();
    for (const result of results) mock.mockReturnValueOnce(result);
    return mock;
}
function prepare(command: string[], mock: ReturnType<typeof runner>) {
    return prepareCodexLaunch("docker", prefix, command, mock as unknown as typeof spawnSync);
}

describe("non-destructive Codex launch", () => {
    it.each([
        ["codex"],
        ["codex", bypass],
        ["codex", "resume", bypass, "session-id", "continue this work"],
        ["codex", "fork", bypass, "--last", "make another variant"],
        ["codex", "-m", "model-a", "resume", "session-id"],
        ["codex", bypass, "--", "exec"],
        ["codex", bypass, "-c", 'profile="exec"', "--image", "/tmp/image with spaces.png", "explain the image"],
    ])("starts a missing daemon once without altering original arguments: %j", (...args) => {
        const command = args as string[];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        const actual = prepare(command, mock);
        expect(actual).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(3);
        for (const call of mock.mock.calls) {
            expect(call[0]).toBe("docker");
            expect(call[1].slice(0, prefix.length)).toEqual(prefix);
            expect(call[2].timeout).toBeGreaterThan(0);
            expect(call[2].timeout).toBeLessThanOrEqual(120000);
        }
        expect(mock.mock.calls[2][1].slice(prefix.length, prefix.length + 4)).toEqual(["codex", "app-server", "daemon", "start"]);
    });

    it.each([
        ["codex", "exec", "perform action"], ["codex", "review"], ["codex", "login"],
        ["codex", "app-server", "daemon", "start"], ["codex", bypass, "unknown-command"],
        ["codex", bypass, "doctor"], ["codex", "resume", "--remote", "unix:///socket"],
        ["codex", "fork", "--remote=wss://example.invalid"], ["codex", bypass, "--no-daemon"],
        ["codex", "--help"], ["codex", "resume", "-h"], ["codex", "--version"],
    ])("does not probe or modify excluded invocations: %j", (...args) => {
        const command = args as string[];
        const mock = runner();
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).not.toHaveBeenCalled();
    });

    it.each([probe(0), probe(1), probe(1, "runtime unavailable"), probe(1, "ccc-codex-daemon-missing\n", { stderr: "container failed" }), probe(2), probe(126), probe(null, "", { signal: "SIGTERM" }), probe(null, "", { error: new Error("timeout") })])(
        "keeps invocation unchanged unless absence is positively confirmed: %j", result => {
            const command = ["codex", "resume", "session-id"];
            const mock = runner(result);
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(1);
        },
    );

    it.each([probe(0, "Usage: old codex"), probe(1, startHelp), probe(null, startHelp, { signal: "SIGTERM" })])(
        "does not start a daemon without a successful supported-command probe: %j", help => {
            const command = ["codex", "fork", "--last"];
            const mock = runner(missingDaemon(), help);
            const result = prepare(command, mock);
            expect(result.command).toEqual(command);
            expect(result).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(2);
        },
    );

    it("does not confuse flag values with command names or remote options", () => {
        const command = ["codex", "-m", "exec", "-c", 'x="--remote"', "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        const result = prepare(command, mock);
        expect(result).toEqual(ready(command));
        expect(mock.mock.calls[2][1].slice(prefix.length)).toEqual(["codex", "app-server", "daemon", "start", "-c", 'x="--remote"']);
    });

    it("forwards only supported configuration arguments with exact order and quoting boundaries", () => {
        const overrides = ["--config", 'note="$(touch /tmp/not-run)"', "-cmodel=\"a b\"", "--enable=feature_a", "--disable", "feature_b"];
        const command = ["codex", ...overrides, "resume", "session-id", "-i", "/tmp/image.png", "continue now"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock.mock.calls[2][1]).toEqual([...prefix, "codex", "app-server", "daemon", "start", ...overrides]);
    });

    it("accepts idempotent already-running startup without restarting or changing mode", () => {
        const command = ["codex", "fork", "--last"];
        const mock = runner(missingDaemon(), probe(0, startHelp), probe(0, '{"status":"alreadyRunning"}'));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(3);
        expect(mock.mock.calls[2][1]).not.toContain("restart");
        expect(mock.mock.calls[2][1]).not.toContain("--no-daemon");
    });

    it.each([
        [probe(7, "", { stderr: "daemon failed" }), 7],
        [probe(null, "", { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }), 1],
        [probe(null, "", { signal: "SIGINT" }), 130],
        [probe(null, "", { signal: "SIGTERM" }), 143],
    ] as const)("returns explicit failure for unsuccessful startup: %j", (started, expectedStatus) => {
        const command = ["codex", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), started);
        const result = prepare(command, mock);
        expect(result).toEqual(expect.objectContaining({ ok: false, command, status: expectedStatus, error: expect.any(String) }));
        expect(mock).toHaveBeenCalledTimes(3);
    });

    it.each([["-p", "custom"], ["--profile=custom"]])("does not initialize a daemon under a silently different profile: %j", (...profile) => {
        const command = ["codex", ...profile, "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp));
        expect(prepare(command, mock)).toEqual(expect.objectContaining({ ok: false, command, status: 1, error: expect.stringMatching(/profile/i) }));
        expect(mock).toHaveBeenCalledTimes(2);
    });

    it("does not block profiles on older CLIs without daemon start support", () => {
        const command = ["codex", "--profile", "custom", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(1, "", { stderr: "unknown command daemon" }));
        expect(prepare(command, mock)).toEqual(ready(command));
        expect(mock).toHaveBeenCalledTimes(2);
    });

    it("executes the read-only probe against the selected CODEX_HOME and preserves its session state", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-codex-probe-"));
        const selectedHome = join(home, "custom codex home");
        mkdirSync(selectedHome);
        const session = join(selectedHome, "session.jsonl");
        writeFileSync(session, "existing-session-history\n");
        const executable = join(selectedHome, "packages", "app-server-daemon", "current", "bin", "codex");
        const command = ["codex", "resume", "session-id"];
        const mock = vi.fn((_runtime: string, args: string[]) => {
            const scriptIndex = args.indexOf("-e");
            if (scriptIndex >= 0) {
                return spawnSync(process.execPath, ["-e", args[scriptIndex + 1]], {
                    encoding: "utf8", timeout: 5000,
                    env: { ...process.env, HOME: home, CODEX_HOME: selectedHome },
                });
            }
            return probe(0, args.includes("--help") ? startHelp : "");
        });
        try {
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(3);
            mkdirSync(join(selectedHome, "packages", "app-server-daemon", "current", "bin"), { recursive: true });
            writeFileSync(executable, "#!/bin/sh\nexit 0\n");
            chmodSync(executable, 0o755);
            mock.mockClear();
            expect(prepare(command, mock)).toEqual(ready(command));
            expect(mock).toHaveBeenCalledTimes(1);
            expect(readFileSync(session, "utf8")).toBe("existing-session-history\n");
            expect(readFileSync(executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("leaves command untouched if a probe runner throws", () => {
        const command = ["codex", "resume", "session-id"];
        const mock = vi.fn(() => { throw new Error("runtime unavailable"); });
        expect(prepare(command, mock)).toEqual(ready(command));
    });

    it("removes the destructive recovery ladder from the real launch entry point", () => {
        const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        for (const obsolete of ["offerCodexStateWipe", "CODEX_STATE_WIPE_COMMAND", "forceUpdateCodexInContainer", "isCodexLikelyFailure", "Wipe everything in ~/.codex"]) {
            expect(source).not.toContain(obsolete);
        }
        expect(source).toContain("prepareCodexLaunch");
    });

    it.each([true, false])("runs common cleanup and launches TUI only after successful preparation (failed=%s)", failed => {
        const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        const start = source.indexOf("let preparationStatus:");
        const end = source.indexOf("if (process.env.DEBUG)", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        // Execute the real entry-point block, replacing only its external effects.
        const js = transpileModule(source.slice(start, end) + "\nreturn resultStatus;", {
            compilerOptions: { target: ScriptTarget.ES2022 },
        }).outputText;
        const events: string[] = [];
        const command = ["codex", "resume", "session-id"];
        const launch = vi.fn(() => { events.push("launch"); return { status: 23 }; });
        const execute = new Function("commandTool", "options", "prepareCodexLaunch", "runtimeCli", "execArgs", "containerName", "resolvedCmd", "process", "console", "CLAUDE_BIN_PATH", "cmd", "spawnSync", "restoreCodexConfigHostOwnership", "unlinkSync", "envFile", js);
        const status = execute(
            { name: "codex" }, { interactive: true },
            () => failed ? { ok: false, command, status: 7, error: "initialization failed" } : ready(command),
            () => "docker", [...prefix.slice(0, -1)], "ccc-fixture", command,
            { stdin: { isTTY: false }, stdout: { isTTY: false } }, { error: vi.fn() }, "unused", command,
            launch, () => events.push("ownership-cleanup"), () => events.push("env-cleanup"), "/tmp/private-env",
        );
        expect(status).toBe(failed ? 7 : 23);
        expect(events).toEqual(failed ? ["ownership-cleanup", "env-cleanup"] : ["launch", "ownership-cleanup", "env-cleanup"]);
        expect(launch).toHaveBeenCalledTimes(failed ? 0 : 1);
        if (!failed) expect(launch.mock.calls[0]).toEqual(["docker", [...prefix, ...command], { stdio: "inherit" }]);
    });
});


const missingStart = () => probe(1, "", { stderr: "Error: daemon executable not found at /home/user/.codex/packages/app-server-daemon/current/bin/codex; run daemon update" });
const fallbackHelp = "Usage: codex [OPTIONS]\n      --no-daemon\n          Run an in-process server\n";

describe("one-session fallback for a positively broken daemon installation", () => {
    it.each([
        ["codex", "resume", "session-id", "continue now"],
        ["codex", "fork", "--last", "make another variant"],
        ["codex", "-c", 'literal="$(touch /tmp/not-run)"', "resume", "session-id", "--image", "/tmp/image with spaces.png"],
    ])("uses the supported global flag without dropping original arguments: %j", (...args) => {
        const command = args as string[];
        const mock = runner(missingDaemon(), probe(0, startHelp), missingStart(), probe(0, fallbackHelp));
        const result = prepare(command, mock);
        expect(result).toEqual({ ok: true, command: ["codex", "--no-daemon", ...command.slice(1)], notice: expect.stringContaining("without the background server") });
        expect(command).not.toContain("--no-daemon");
        expect(mock).toHaveBeenCalledTimes(4);
        expect(mock.mock.calls[3][1]).toEqual([...prefix, "codex", "--help"]);
        expect(mock.mock.calls[3][2]).toMatchObject({ timeout: 5000, maxBuffer: 64 * 1024 });
        expect(mock.mock.calls.flatMap((call) => call[1])).not.toContain("update");
        expect(mock.mock.calls.filter((call) => call[1].includes("start") && !call[1].includes("--help"))).toHaveLength(1);
    });
    it.each([
        probe(1, "", { stderr: "Socket permission denied" }),
        probe(1, missingStart().stderr),
        probe(null, "", { stderr: missingStart().stderr, signal: "SIGINT" }),
        probe(null, "", { stderr: missingStart().stderr, error: new Error("timeout") }),
    ])("never falls back for unrelated, interrupted or timed-out startup: %j", (failure) => {
        const mock = runner(missingDaemon(), probe(0, startHelp), failure);
        expect(prepare(["codex"], mock).ok).toBe(false);
        expect(mock).toHaveBeenCalledTimes(3);
    });
    it.each([
        probe(0, "Usage: codex --no-daemon-is-not-a-flag"),
        probe(0, "Documentation mentions --no-daemon but does not advertise it"),
        probe(1, fallbackHelp),
        probe(null, fallbackHelp, { signal: "SIGTERM" }),
        probe(null, fallbackHelp, { error: new Error("help timeout") }),
    ])("requires positively advertised fallback support: %j", (help) => {
        const command = ["codex", "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, startHelp), missingStart(), help);
        expect(prepare(command, mock)).toMatchObject({ ok: false, command });
        expect(mock).toHaveBeenCalledTimes(4);
    });
    it("leaves partial daemon files, control endpoint and history unchanged", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-codex-fallback-"));
        const current = join(home, "packages", "app-server-daemon", "current");
        mkdirSync(current, { recursive: true });
        mkdirSync(join(home, "app-server-control"));
        const files = [join(home, "history.jsonl"), join(current, "preserve-package-data"), join(home, "app-server-control", "app-server-control.sock")];
        for (const file of files) writeFileSync(file, "retain original bytes\n");
        const mock = vi.fn((_runtime: string, args: string[]) => {
            if (args[prefix.length] === "node") return spawnSync(process.execPath, args.slice(prefix.length + 1), { encoding: "utf8", timeout: 5000, env: { ...process.env, CODEX_HOME: home } });
            if (args.includes("start")) return args.includes("--help") ? probe(0, startHelp) : missingStart();
            return probe(0, fallbackHelp);
        });
        try {
            expect(prepare(["codex", "resume", "session-id"], mock)).toMatchObject({ ok: true, command: ["codex", "--no-daemon", "resume", "session-id"] });
            expect(mock).toHaveBeenCalledTimes(4);
            for (const file of files) expect(readFileSync(file, "utf8")).toBe("retain original bytes\n");
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it("launches the returned fallback command once, prints the notice, and still cleans up", () => {
        const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        const start = source.indexOf("let preparationStatus:");
        const end = source.indexOf("if (process.env.DEBUG)", start);
        const js = transpileModule(source.slice(start, end) + "\nreturn resultStatus;", { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
        const events: string[] = [];
        const command = ["codex", "resume", "session-id"];
        const fallback = ["codex", "--no-daemon", "resume", "session-id"];
        const launch = vi.fn(() => { events.push("launch"); return { status: 0 }; });
        const execute = new Function("commandTool", "options", "prepareCodexLaunch", "runtimeCli", "execArgs", "containerName", "resolvedCmd", "process", "console", "CLAUDE_BIN_PATH", "cmd", "spawnSync", "restoreCodexConfigHostOwnership", "unlinkSync", "envFile", js);
        const result = execute({ name: "codex" }, { interactive: true }, () => ({ ok: true, command: fallback, notice: "daemon fallback" }), () => "docker", [...prefix.slice(0, -1)], "ccc-fixture", command,
            { stdin: { isTTY: false }, stdout: { isTTY: false } }, { error: (message: string) => events.push(message) }, "unused", command, launch,
            () => events.push("ownership-cleanup"), () => events.push("env-cleanup"), "/tmp/private-env");
        expect(result).toBe(0);
        expect(launch).toHaveBeenCalledExactlyOnceWith("docker", [...prefix, ...fallback], { stdio: "inherit" });
        expect(events).toEqual(["[ccc] daemon fallback", "launch", "ownership-cleanup", "env-cleanup"]);
    });
});
