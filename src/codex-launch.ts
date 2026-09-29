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

function interactiveCommandIndex(command: readonly string[]): number | null {
    if (command[0] !== "codex") return null;
    let subcommandIndex = 0;
    let positional = false;
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (argument === "--") return subcommandIndex;
        if (argument.startsWith("-")) {
            const [flag] = argument.split("=", 1);
            if (VALUE_FLAGS.has(flag)) {
                if (!argument.includes("=") && ++index >= command.length) return null;
                continue;
            }
            // Accept attached short option values such as -cmodel="...".
            if (!argument.startsWith("--") && argument.length > 2 && VALUE_FLAGS.has(argument.slice(0, 2))) continue;
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
    return subcommandIndex;
}

export function isInteractiveCodexCommand(command: readonly string[]): boolean {
    return interactiveCommandIndex(command) !== null;
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

/** Read-only fallback selection. Never replay a failed command or mutate Codex state. */
export function prepareCodexLaunch(
    runtime: string,
    execPrefix: readonly string[],
    command: readonly string[],
    runner: typeof spawnSync = spawnSync,
): string[] {
    const original = [...command];
    const commandIndex = interactiveCommandIndex(command);
    if (commandIndex === null) return original;
    const probeOptions = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" as const };
    try {
        const executable = runner(runtime, [...execPrefix, "node", "-e", DAEMON_EXECUTABLE_PROBE], probeOptions);
        if (executable.error || executable.signal || executable.status !== 1
            || executable.stdout !== "ccc-codex-daemon-missing\n" || executable.stderr !== "") return original;
        const help = runner(runtime, [...execPrefix, command[0], ...(commandIndex ? [command[commandIndex]] : []), "--help"], probeOptions);
        if (help.error || help.signal || help.status !== 0 || !/(?:^|\s)--no-daemon(?:\s|$)/m.test(String(help.stdout))) return original;
        original.splice(commandIndex + 1, 0, "--no-daemon");
        return original;
    } catch {
        return original;
    }
}
