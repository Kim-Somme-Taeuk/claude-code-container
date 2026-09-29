import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface ResumeProcessResult {
    code: number;
    output: string;
    stderr: string;
    overflow: boolean;
    signal: NodeJS.Signals | null;
}

export interface ResumeStdinAction {
    input?: string;
    closeInput?: boolean;
}

export interface ResumeProcessOptions {
    input?: string;
    onStdoutLine?: (line: string) => ResumeStdinAction | void;
    terminal?: boolean;
    timeoutMs?: number;
    direct?: boolean;
}

export interface ResumeProcessRunner {
    run(args: readonly string[], options?: ResumeProcessOptions): Promise<ResumeProcessResult>;
    readonly interrupted: number;
    dispose(): void;
}

const SIGNAL_CODES: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export function terminalResumeCommand(args: readonly string[]): string[] {
    const quoted = args.map(value => "'" + value.replace(/'/g, "'\\''") + "'").join(" ");
    return ["/usr/bin/script", "-q", "-e", "-f", "-c", "exec " + quoted, "/dev/null"];
}

/** Signal handlers belong to one recovery invocation and are removed by dispose. */
export function createResumeProcessRunner(): ResumeProcessRunner {
    let active: ChildProcess | undefined;
    let activeTerminal = false;
    let interrupted = 0;
    const handlers: Array<[NodeJS.Signals, () => void]> = [];
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        handlers.push([signal, () => {
            interrupted = SIGNAL_CODES[signal]!;
            // util-linux script may inherit ignored HUP; TERM performs its PTY cleanup.
            active?.kill(signal === "SIGHUP" && activeTerminal ? "SIGTERM" : signal);
        }]);
    }
    handlers.push(["SIGWINCH", () => { active?.kill("SIGWINCH"); }]);
    for (const [signal, handler] of handlers) process.on(signal, handler);

    function run(args: readonly string[], options: ResumeProcessOptions = {}): Promise<ResumeProcessResult> {
        const { terminal = false, timeoutMs = 0, direct = false, input, onStdoutLine } = options;
        return new Promise(resolve => {
            let output: Buffer = Buffer.alloc(0);
            let stderr: Buffer = Buffer.alloc(0);
            let received = 0;
            let overflow = false;
            let failed = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const child = spawn(args[0], args.slice(1), {
                stdio: direct ? "inherit" : [terminal ? "inherit" : input !== undefined || onStdoutLine ? "pipe" : "ignore", "pipe", "pipe"],
            });
            active = child;
            activeTerminal = terminal;
            const limit = terminal ? 16384 : 65536;
            const decoder = new StringDecoder("utf8");
            let pendingLine = "";
            let pendingInput = "";
            let waitingForDrain = false;
            let closeInput = false;
            function fail(): void {
                failed = true;
                child.kill("SIGKILL");
            }
            function flushInput(): void {
                if (failed || waitingForDrain) return;
                try {
                    if (pendingInput) {
                        if (!child.stdin?.writable || child.stdin.destroyed) { fail(); return; }
                        const chunk = pendingInput;
                        pendingInput = "";
                        waitingForDrain = !child.stdin.write(chunk);
                    }
                    if (closeInput && !waitingForDrain) child.stdin?.end();
                } catch { fail(); }
            }
            function send(action: ResumeStdinAction | void): void {
                if (!action) return;
                if (action.input) {
                    if (closeInput) { fail(); return; }
                    pendingInput += action.input;
                    if (Buffer.byteLength(pendingInput) > 65536) { fail(); return; }
                }
                if (action.closeInput) closeInput = true;
                flushInput();
            }
            child.stdin?.on("error", fail);
            child.stdin?.on("drain", () => { waitingForDrain = false; flushInput(); });
            function lines(chunk: string, ended = false): void {
                if (!onStdoutLine || failed || overflow) return;
                pendingLine += chunk;
                try {
                    let newline: number;
                    while ((newline = pendingLine.indexOf("\n")) >= 0) {
                        const line = pendingLine.slice(0, newline).replace(/\r$/, "");
                        pendingLine = pendingLine.slice(newline + 1);
                        send(onStdoutLine(line));
                        if (failed) return;
                    }
                    if (ended && pendingLine) {
                        send(onStdoutLine(pendingLine));
                        pendingLine = "";
                    }
                } catch { fail(); }
            }
            function collect(chunk: Buffer, stream: Writable, readable: Readable): void {
                if (terminal && !stream.write(chunk)) {
                    readable.pause();
                    stream.once("drain", () => readable.resume());
                }
                received += chunk.length;
                if (!terminal && stream === process.stderr) stderr = Buffer.concat([stderr, chunk]).subarray(-limit);
                else output = Buffer.concat([output, chunk]);
                if ((terminal ? output.length : received) > limit) {
                    if (!terminal) {
                        overflow = true;
                        child.kill("SIGKILL");
                    }
                    output = output.subarray(output.length - limit);
                }
            }
            const stdoutStream = child.stdout;
            const stderrStream = child.stderr;
            stdoutStream?.on("data", (chunk: Buffer) => {
                collect(chunk, process.stdout, stdoutStream);
                if (onStdoutLine) lines(decoder.write(chunk));
            });
            stdoutStream?.on("end", () => lines(decoder.end(), true));
            stderrStream?.on("data", (chunk: Buffer) => collect(chunk, process.stderr, stderrStream));
            if (timeoutMs) timer = setTimeout(() => {
                overflow = true;
                child.kill("SIGKILL");
            }, timeoutMs);
            child.on("error", () => { failed = true; });
            if (input !== undefined) send({ input });
            child.on("close", (code, signal) => {
                clearTimeout(timer);
                if (active === child) active = undefined;
                resolve({
                    code: interrupted || (failed ? 1 : signal ? SIGNAL_CODES[signal] || 1 : code ?? 1),
                    output: output.toString("utf8"),
                    stderr: stderr.toString("utf8"),
                    overflow,
                    signal,
                });
            });
        });
    }

    return {
        run,
        get interrupted() { return interrupted; },
        dispose() {
            for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        },
    };
}
