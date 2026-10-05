import { spawnSync } from "child_process";

const VALUE_FLAGS = new Set([
    "-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
    "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
    "--add-dir", "-a", "--ask-for-approval",
]);
const BOOLEAN_FLAGS = new Set([
    "--oss", "--strict-config", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen",
    "--last", "--all", "--include-non-interactive",
]);

interface InteractiveCommand {
    daemonArgs: string[];
    profile: boolean;
}

function interactiveCommand(command: readonly string[]): InteractiveCommand | null {
    if (command[0] !== "codex") return null;
    let subcommandIndex = 0;
    const result: InteractiveCommand = { daemonArgs: [], profile: false };
    let positional = false;
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (argument === "--") return result;
        if (argument.startsWith("-")) {
            const [flag] = argument.split("=", 1);
            if (VALUE_FLAGS.has(flag)) {
                const args = [argument];
                if (!argument.includes("=")) {
                    if (++index >= command.length) return null;
                    args.push(command[index]);
                }
                if (["-c", "--config", "--enable", "--disable"].includes(flag)) result.daemonArgs.push(...args);
                if (flag === "-p" || flag === "--profile") result.profile = true;
                continue;
            }
            // Accept attached short option values such as -cmodel="...".
            if (!argument.startsWith("--") && argument.length > 2 && VALUE_FLAGS.has(argument.slice(0, 2))) {
                if (argument.startsWith("-c")) result.daemonArgs.push(argument);
                if (argument.startsWith("-p")) result.profile = true;
                continue;
            }
            if (!BOOLEAN_FLAGS.has(argument)) return null;
            continue;
        }
        if (!positional && subcommandIndex === 0) {
            if (argument === "resume" || argument === "fork") subcommandIndex = index;
            // An unrecognized bare word might be a new administrative command.
            else if (!/\s/.test(argument)) return null;
        }
        positional = true;
    }
    return result;
}

export function isInteractiveCodexCommand(command: readonly string[]): boolean {
    return interactiveCommand(command) !== null;
}

const DAEMON_EXECUTABLE_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
try {
    fs.accessSync(path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', 'codex'), fs.constants.X_OK);
} catch (error) {
    if (error.code === 'ENOENT') process.stdout.write('ccc-codex-daemon-missing\\n');
    process.exitCode = error.code === 'ENOENT' ? 1 : 2;
}
`;

export type CodexLaunchPreparation =
    | { ok: true; command: string[]; notice?: string }
    | { ok: false; command: string[]; status: number; error: string };

/** Initialize a positively missing daemon without changing or replaying the user command. */
export function prepareCodexLaunch(
    runtime: string,
    execPrefix: readonly string[],
    command: readonly string[],
    runner: typeof spawnSync = spawnSync,
): CodexLaunchPreparation {
    const original = [...command];
    const unchanged = { ok: true as const, command: original };
    const interactive = interactiveCommand(command);
    if (!interactive) return unchanged;
    const probeOptions = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" as const };
    try {
        const executable = runner(runtime, [...execPrefix, "node", "-e", DAEMON_EXECUTABLE_PROBE], probeOptions);
        if (executable.error || executable.signal || executable.status !== 1
            || executable.stdout !== "ccc-codex-daemon-missing\n" || executable.stderr !== "") return unchanged;
    } catch {
        return unchanged;
    }
    const failure = (error: string, status = 1): CodexLaunchPreparation => ({ ok: false, command: original, status, error });
    const startArgs = [...execPrefix, command[0], "app-server", "daemon", "start"];
    let help;
    try {
        help = runner(runtime, [...startArgs, "--help"], probeOptions);
    } catch {
        return unchanged;
    }
    if (help.error || help.signal || help.status !== 0
        || !/Usage:\s+\S+\s+app-server\s+daemon\s+start\b/.test(String(help.stdout))) return unchanged;
    if (interactive.profile) return failure("Codex daemon is missing; automatic initialization does not support --profile. Start the daemon with the intended configuration before resuming.");
    try {
        const start = runner(runtime, [...startArgs, ...interactive.daemonArgs], { ...probeOptions, timeout: 60000 });
        if (!start.error && !start.signal && start.status !== 0
            && /Error: daemon executable not found at [^\r\n]+[\/]packages[\/]app-server-daemon[\/]current[\/]bin[\/]codex;/.test(String(start.stderr))) {
            const help = runner(runtime, [...execPrefix, command[0], "--help"], probeOptions);
            if (!help.error && !help.signal && help.status === 0
                && /^\s+--no-daemon\s*$/m.test(String(help.stdout))) {
                return {
                    ok: true,
                    command: [original[0], "--no-daemon", ...original.slice(1)],
                    notice: "Codex daemon installation is incomplete; running this session without the background server. Session history is preserved.",
                };
            }
        }
        if (start.error || start.signal || start.status !== 0) {
            const status = start.signal === "SIGINT" ? 130 : start.signal === "SIGTERM" ? 143 : start.signal === "SIGHUP" ? 129
                : typeof start.status === "number" && start.status > 0 ? start.status : 1;
            const cause = start.error?.message || (start.signal ? `signal ${start.signal}` : String(start.stderr || start.stdout).trim() || `exit ${start.status}`);
            return failure(`Codex daemon initialization failed: ${cause.slice(0, 1000)}`, status);
        }
        return unchanged;
    } catch (error) {
        return failure(`Codex daemon initialization failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`);
    }
}
