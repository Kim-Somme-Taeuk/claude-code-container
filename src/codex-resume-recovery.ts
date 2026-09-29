const VALUE_OPTIONS = new Set([
    "-c", "--config", "--enable", "--disable", "-m", "--model", "-s", "--sandbox",
    "-a", "--ask-for-approval", "--local-provider", "--add-dir",
]);
const CONFIG_OPTIONS = new Set(["-c", "--config", "--enable", "--disable"]);
const BOOLEAN_OPTIONS = new Set([
    "--no-daemon", "--no-alt-screen", "--oss", "--strict-config", "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--search",
]);
const SELECTOR_OPTIONS = new Set(["--last", "--all", "--include-non-interactive"]);

const RECOVERY_SCRIPT = String.raw`
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {stripVTControlCharacters} = require('node:util');
const {command, retry, config, selector} = JSON.parse(process.argv[1]);
let active, activeTerminal = false, interrupted = 0;
for (const [signal, code] of [['SIGINT',130],['SIGTERM',143],['SIGHUP',129]]) {
    process.on(signal, () => {
        interrupted = code;
        // util-linux script may inherit ignored HUP; TERM performs its PTY cleanup.
        active?.kill(signal === 'SIGHUP' && activeTerminal ? 'SIGTERM' : signal);
    });
}
process.on('SIGWINCH', () => active?.kill('SIGWINCH'));
function run(args, terminal = false, timeout = 0, direct = false) {
    return new Promise(resolve => {
        let output = Buffer.alloc(0), stderr = Buffer.alloc(0), received = 0, overflow = false, timer;
        const child = spawn(args[0], args.slice(1), {
            stdio: direct ? 'inherit' : [terminal ? 'inherit' : 'ignore', 'pipe', 'pipe'],
        });
        active = child;
        activeTerminal = terminal;
        const limit = terminal ? 16384 : 65536;
        function collect(chunk, stream, readable) {
            if (terminal && !stream.write(chunk)) {
                readable.pause();
                stream.once('drain', () => readable.resume());
            }
            received += chunk.length;
            if (!terminal && stream === process.stderr) stderr = Buffer.concat([stderr, chunk]).subarray(-limit);
            else output = Buffer.concat([output, chunk]);
            if ((terminal ? output.length : received) > limit) {
                if (!terminal) { overflow = true; child.kill('SIGKILL'); }
                output = output.subarray(output.length - limit);
            }
        }
        child.stdout?.on('data', chunk => collect(chunk, process.stdout, child.stdout));
        child.stderr?.on('data', chunk => collect(chunk, process.stderr, child.stderr));
        if (timeout) timer = setTimeout(() => { overflow = true; child.kill('SIGKILL'); }, timeout);
        child.on('error', () => {});
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (active === child) active = undefined;
            resolve({code: interrupted || (signal ? ({SIGINT:130,SIGTERM:143,SIGHUP:129}[signal] || 1) : code ?? 1),
                output: output.toString('utf8'), stderr: stderr.toString('utf8'), overflow, signal});
        });
    });
}
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function terminalArgs(args) {
    return ['/usr/bin/script','-q','-e','-f','-c','exec ' + args.map(quote).join(' '),'/dev/null'];
}
function failedThread(output) {
    // Codex resets the cursor before its final error without necessarily printing a newline.
    const text = stripVTControlCharacters(output.replace(/\x1b\[0 q/g, '\n')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).trimEnd();
    const finalLine = text.slice(text.lastIndexOf('\n') + 1);
    const match = /^Error: Failed to resume session from (\/[^\r\n]+): thread\/resume failed during TUI bootstrap: thread\/resume failed: list_turns is not supported yet \(code -32601\)$/.exec(finalLine);
    if (!match) return null;
    const filename = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(match[1]));
    if (!filename) return null;
    if (selector && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
        && selector.toLowerCase() !== filename[1].toLowerCase()) return null;
    try {
        const home = fs.realpathSync(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'));
        const file = fs.realpathSync(match[1]);
        const relative = path.relative(home, file);
        if (!/^(sessions|archived_sessions)\//.test(relative) || !fs.statSync(file).isFile()) return null;
        if (path.basename(file) !== path.basename(match[1])) return null;
        return filename[1].toLowerCase();
    } catch { return null; }
}
(async () => {
    const script = await run(['/usr/bin/script','--version'], false, 5000);
    if (interrupted) return interrupted;
    if (script.code !== 0 || !script.output.includes('util-linux')) return (await run(command, false, 0, true)).code;
    const first = await run(terminalArgs(command), true);
    if (first.code !== 1 || interrupted || first.signal) return first.code;
    const id = failedThread(first.output);
    if (!id) return first.code;
    const help = await run([command[0], 'migrate-rollouts', '--help'], false, 5000);
    if (interrupted) return interrupted;
    if (help.code !== 0 || help.overflow || !/Usage:\s+\S+\s+migrate-rollouts\b/.test(help.output)
        || !help.output.includes('--apply') || !help.output.includes('--thread') || !help.output.includes('--json')) return first.code;
    process.stderr.write('[ccc] Repairing this session\'s history index and resuming once.\n');
    const migration = await run([command[0], 'migrate-rollouts', ...config, '--apply', '--thread', id, '--json'], false, 60000);
    if (interrupted) return interrupted;
    let repaired = false;
    if (migration.code === 0 && !migration.signal && !migration.overflow) {
        try {
            const result = JSON.parse(migration.output);
            repaired = Array.isArray(result.outcomes) && result.outcomes.length === 1
                && result.outcomes[0].thread_id === id
                && ['migrated', 'already_paginated'].includes(result.outcomes[0].status);
        } catch {}
    }
    if (!repaired) {
        process.stderr.write('[ccc] Automatic session repair did not complete; history was not deleted.\n');
        const diagnostic = migration.stderr || migration.output;
        if (diagnostic) process.stderr.write(diagnostic.slice(-2000) + '\n');
        return first.code;
    }
    return (await run(terminalArgs([...retry, id]), true)).code;
})().then(code => { process.exitCode = code; }, error => {
    process.stderr.write('[ccc] Resume recovery failed: ' + error.message + '\n');
    process.exitCode = interrupted || 1;
});
`;

/** Wrap only local resume without a prompt; the container retains its existing identity and environment. */
export function buildCodexResumeRecoveryCommand(command: readonly string[]): string[] {
    const unchanged = [...command];
    if (command[0] !== "codex") return unchanged;
    let resume = false;
    let selector: string | undefined;
    const retry = [command[0]];
    const config: string[] = [];
    for (let index = 1; index < command.length; index += 1) {
        const argument = command[index];
        if (!argument.startsWith("-")) {
            if (!resume) {
                if (argument !== "resume") return unchanged;
                resume = true;
                retry.push(argument);
            } else if (selector === undefined) selector = argument;
            else return unchanged; // A second positional argument is a prompt and must never be replayed.
            continue;
        }
        const equals = argument.indexOf("=");
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        if (VALUE_OPTIONS.has(flag)) {
            const values = [argument];
            if (equals < 0) {
                if (++index >= command.length) return unchanged;
                values.push(command[index]);
            }
            retry.push(...values);
            if (CONFIG_OPTIONS.has(flag)) config.push(...values);
        } else if (SELECTOR_OPTIONS.has(argument) && resume) {
            // The failed picker/last selection is replaced by its validated UUID after recovery.
        } else if (BOOLEAN_OPTIONS.has(argument)) retry.push(argument);
        else return unchanged;
    }
    if (!resume) return unchanged;
    return ["node", "-e", RECOVERY_SCRIPT, "--", JSON.stringify({ command: unchanged, retry, config, selector })];
}
