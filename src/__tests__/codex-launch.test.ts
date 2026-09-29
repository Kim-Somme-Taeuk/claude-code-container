import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCodexLaunch } from "../codex-launch.js";

const prefix = ["exec", "-w", "/project/with spaces", "--env-file", "/tmp/private-env", "ccc-fixture"];
const bypass = "--dangerously-bypass-approvals-and-sandbox";
function probe(status: number | null, stdout = "", extra = {}) {
    return { status, stdout, stderr: "", signal: null, ...extra };
}
function missingDaemon() { return probe(1, "ccc-codex-daemon-missing\n"); }
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
    ])("adds one supported fallback without altering original arguments: %j", (...args) => {
        const command = args as string[];
        const mock = runner(missingDaemon(), probe(0, "Usage: codex\n --no-daemon  Run without shared server\n"));
        const actual = prepare(command, mock);
        expect(actual.filter(arg => arg === "--no-daemon")).toHaveLength(1);
        expect(actual.filter(arg => arg !== "--no-daemon")).toEqual(command);
        expect(mock).toHaveBeenCalledTimes(2);
        for (const call of mock.mock.calls) {
            expect(call[0]).toBe("docker");
            expect(call[1].slice(0, prefix.length)).toEqual(prefix);
            expect(call[2].timeout).toBeGreaterThan(0);
            expect(call[2].timeout).toBeLessThanOrEqual(30000);
        }
        const separator = actual.indexOf("--");
        if (separator >= 0) expect(actual.indexOf("--no-daemon")).toBeLessThan(separator);
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
        expect(prepare(command, mock)).toEqual(command);
        expect(mock).not.toHaveBeenCalled();
    });

    it.each([probe(0), probe(1), probe(1, "runtime unavailable"), probe(1, "ccc-codex-daemon-missing\n", { stderr: "container failed" }), probe(2), probe(126), probe(null, "", { signal: "SIGTERM" }), probe(null, "", { error: new Error("timeout") })])(
        "keeps invocation unchanged unless absence is positively confirmed: %j", result => {
            const command = ["codex", "resume", "session-id"];
            const mock = runner(result);
            expect(prepare(command, mock)).toEqual(command);
            expect(mock).toHaveBeenCalledTimes(1);
        },
    );

    it.each([probe(0, "Usage: old codex"), probe(1, "--no-daemon"), probe(null, "--no-daemon", { signal: "SIGTERM" })])(
        "requires a successful supported-flag probe: %j", help => {
            const command = ["codex", "fork", "--last"];
            const mock = runner(missingDaemon(), help);
            expect(prepare(command, mock)).toEqual(command);
        },
    );

    it("does not confuse flag values with command names or remote options", () => {
        const command = ["codex", "-m", "exec", "-c", 'x="--remote"', "resume", "session-id"];
        const mock = runner(missingDaemon(), probe(0, "--no-daemon"));
        const result = prepare(command, mock);
        expect(result).toContain("--no-daemon");
        expect(result.filter(arg => arg !== "--no-daemon")).toEqual(command);
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
            return probe(0, " --no-daemon Run without shared server\n");
        });
        try {
            expect(prepare(command, mock)).toContain("--no-daemon");
            mkdirSync(join(selectedHome, "packages", "app-server-daemon", "current", "bin"), { recursive: true });
            writeFileSync(executable, "#!/bin/sh\nexit 0\n");
            chmodSync(executable, 0o755);
            mock.mockClear();
            expect(prepare(command, mock)).toEqual(command);
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
        expect(prepare(command, mock)).toEqual(command);
    });

    it("removes the destructive recovery ladder from the real launch entry point", () => {
        const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        for (const obsolete of ["offerCodexStateWipe", "CODEX_STATE_WIPE_COMMAND", "forceUpdateCodexInContainer", "isCodexLikelyFailure", "Wipe everything in ~/.codex"]) {
            expect(source).not.toContain(obsolete);
        }
        expect(source).toContain("prepareCodexLaunch");
    });
});
