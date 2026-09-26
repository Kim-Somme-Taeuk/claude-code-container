// src/utils.ts - Shared utilities for ccc

import {createHash, randomBytes} from "crypto";
import {createInterface} from "readline";
import {realpathSync, writeFileSync} from "fs";
import {homedir, tmpdir} from "os";
import {basename, dirname, join, resolve} from "path";
import {normalizeProfile, profileClaudeDir, profileClaudeJsonFile, profileCodexDir} from "./home-layout.js";

// === CLI Version (injected at build time) ===
export const CLI_VERSION: string = "__CLI_VERSION__";

// === Shared Constants ===
export const DATA_DIR = join(homedir(), ".ccc");
export const CLIPBOARD_FILES_CONTAINER_DIR = "/run/ccc/clipboard-files";

function useMountedCredentialPaths(): boolean {
    return process.env.container === CONTAINER_ENV_VALUE
        && !Object.keys(process.env).some((key) => key === "VITEST" || key.startsWith("VITEST_"));
}

// Host paths come from home-layout.ts (doc/common/REQ__ccc-home-layout.md).
// Inside a ccc container the credentials are the mounted ~/.claude and ~/.codex.
export function getClaudeDir(profile?: string): string {
    if (!normalizeProfile(profile) && useMountedCredentialPaths()) return join(homedir(), ".claude");
    return profileClaudeDir(profile);
}

export function getClaudeJsonFile(profile?: string): string {
    if (!normalizeProfile(profile) && useMountedCredentialPaths()) return join(homedir(), ".claude.json");
    return profileClaudeJsonFile(profile);
}

export function getCodexDir(profile?: string): string {
    if (useMountedCredentialPaths()) return join(homedir(), ".codex");
    return profileCodexDir(profile);
}

export function getCodexConfigFile(profile?: string): string {
    return join(getCodexDir(profile), "config.toml");
}
export const IMAGE_NAME = "ccc";
export const DOCKER_REGISTRY_IMAGE = process.env.CCC_REGISTRY || "luxusio/claude-code-container";
export const CONTAINER_PID_LIMIT = "-1"; // -1 = unlimited (same as host)
export const MISE_VOLUME_NAME = "ccc-mise-cache";
// Codex installs its app-server daemon under $CODEX_HOME/packages. Keeping that
// subtree on a named volume avoids a rename that Windows-backed bind mounts
// reject right after a binary inside it ran (doc/common/REQ__codex-daemon-packages-volume.md).
export const CODEX_PACKAGES_VOLUME_NAME = "ccc-codex-packages";
export const CODEX_PACKAGES_CONTAINER_DIR = "/home/ccc/.codex/packages";
export const LAB_RUNNER_PROFILE_NAME = "lab-runner";
export const LAB_RUNNER_STATE_CONTAINER_DIR = "/home/ccc/.ccc/labs";
export const DEFAULT_ENV_FORWARD_BYTE_LIMIT = 64 * 1024;
export const COMMON_IGNORE_DIRS = [
    "node_modules", ".git", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "vendor"
];

// Container marker: set inside container to enable per-project env separation via mise.toml [env]
// Uses systemd convention (https://systemd.io/CONTAINER_INTERFACE/)
export const CONTAINER_ENV_KEY = "container";
export const CONTAINER_ENV_VALUE = "docker";

/**
 * Generate a 12-character SHA256 hash of a path
 */
export function hashPath(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export function canonicalProjectPath(
    projectPath: string,
    platform = process.platform,
    realpath: (path: string) => string = realpathSync.native ?? realpathSync,
): string {
    const resolved = resolve(projectPath);
    if (platform !== "win32") return resolved;
    try {
        return realpath(resolved);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error("Unable to establish canonical Windows project identity", { cause: error });
        }
        try {
            return join(realpath(dirname(resolved)), basename(resolved));
        } catch (parentError) {
            throw new Error("Unable to establish canonical Windows project parent identity", { cause: parentError });
        }
    }
}

export function projectPathsEquivalent(
    left: string,
    right: string,
    platform = process.platform,
    realpath: (path: string) => string = realpathSync.native ?? realpathSync,
): boolean {
    const canonicalLeft = canonicalProjectPath(left, platform, realpath);
    const canonicalRight = canonicalProjectPath(right, platform, realpath);
    return platform === "win32"
        ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
        : canonicalLeft === canonicalRight;
}

/**
 * Resolve the durable logical path used by container names, session locks, and
 * container working directories. This must remain filesystem-independent:
 * canonical filesystem identity is validated separately by
 * canonicalProjectPath/projectPathsEquivalent.
 */
export function projectIdentityPath(
    projectPath: string,
    pathResolver: (path: string) => string = resolve,
): string {
    return pathResolver(projectPath);
}

/**
 * Generate project ID in format: name-hash.
 */
export function getProjectId(
    projectPath: string,
    pathResolver: (path: string) => string = resolve,
): string {
    const identityPath = projectIdentityPath(projectPath, pathResolver);
    const name = basename(identityPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = hashPath(identityPath);
    return `${name}-${hash}`;
}

/**
 * Environment variables to exclude when forwarding to container
 */
export const EXCLUDE_ENV_KEYS = new Set([
    // Unix system
    "PATH", "HOME", "USER", "SHELL", "LOGNAME", "PWD", "OLDPWD",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
    "TMPDIR", "TEMP", "TMP", "XPC_SERVICE_NAME", "XPC_FLAGS", "SHLVL", "_",
    "LaunchInstanceID", "SECURITYSESSIONID", "SSH_AUTH_SOCK",
    // Host display servers — forwarding makes clipboard libs (arboard used by
    // codex) try to reach the host's X11/Wayland socket from inside the
    // container and hang/time out. Clipboard bridges via the CCC HTTP server.
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE",
    "XDG_RUNTIME_DIR", "XDG_SESSION_ID", "XDG_SESSION_CLASS",
    // macOS
    "Apple_PubSub_Socket_Render", "COMMAND_MODE", "COLORTERM",
    "TERM", "ITERM_SESSION_ID", "ITERM_PROFILE", "COLORFGBG",
    "LC_TERMINAL", "LC_TERMINAL_VERSION", "__CF_USER_TEXT_ENCODING",
    // Claude
    "CLAUDE_CONFIG_DIR",
    // CCC internal
    "CCC_TOOL",
    // Windows system (paths are meaningless inside Linux container)
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramData",
    "CommonProgramFiles", "CommonProgramFiles(x86)",
    "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
    "PSModulePath", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS", "COMPUTERNAME",
    // Windows package managers (contain Windows paths like C:\Users\...\AppData)
    "PNPM_HOME", "NPM_CONFIG_PREFIX", "NPM_CONFIG_CACHE",
]);

const EXCLUDE_ENV_PREFIXES = [
    "__MISE_",
    "BASH_FUNC_",
    "npm_config_",
    "npm_package_",
    "NPM_CONFIG_",
];

export interface ForwardedEnvPlan {
    forwarded: Array<[string, string]>;
    skippedDueToLimit: string[];
    totalBytes: number;
}

export function isValidEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function isWindowsPathLike(value: string): boolean {
    return /^[A-Za-z]:[/\\]/.test(value) || /;[A-Za-z]:[/\\]/.test(value);
}

function shouldExcludeEnvKey(key: string, excludeUpper: Set<string>): boolean {
    if (excludeUpper.has(key.toUpperCase())) {
        return true;
    }

    return EXCLUDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function estimateEnvEntryBytes(key: string, value: string): number {
    return Buffer.byteLength(`${key}=${value}`) + 1;
}

export function collectForwardedEnv(
    env: NodeJS.ProcessEnv,
    options: { byteLimit?: number } = {},
): ForwardedEnvPlan {
    const byteLimit = options.byteLimit ?? DEFAULT_ENV_FORWARD_BYTE_LIMIT;
    const excludeUpper = new Set([...EXCLUDE_ENV_KEYS].map((key) => key.toUpperCase()));
    const candidates: Array<{ key: string; value: string; bytes: number }> = [];

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (!isValidEnvKey(key)) continue;
        if (shouldExcludeEnvKey(key, excludeUpper)) continue;
        if (isWindowsPathLike(value)) continue;

        candidates.push({
            key,
            value,
            bytes: estimateEnvEntryBytes(key, value),
        });
    }

    candidates.sort((left, right) => (
        left.bytes - right.bytes
        || left.key.localeCompare(right.key)
    ));

    const forwarded: Array<[string, string]> = [];
    const skippedDueToLimit: string[] = [];
    let totalBytes = 0;

    for (const candidate of candidates) {
        if (totalBytes + candidate.bytes > byteLimit) {
            skippedDueToLimit.push(candidate.key);
            continue;
        }
        forwarded.push([candidate.key, candidate.value]);
        totalBytes += candidate.bytes;
    }

    return { forwarded, skippedDueToLimit, totalBytes };
}

/**
 * Write environment variable entries to a host-side temp file for use with
 * `docker exec --env-file <path>`.
 *
 * Passing many env vars as repeated `-e KEY=VALUE` flags on the docker exec
 * command line can exceed the OS ARG_MAX limit ("Argument list too long").
 * Writing them to a file and passing a single `--env-file` argument avoids
 * that limit regardless of how many variables are forwarded.
 *
 * Entries whose values contain embedded newlines, carriage returns, or null
 * bytes are silently skipped: the Docker env-file format (one KEY=VALUE per
 * line) cannot represent multi-line values.
 *
 * The caller is responsible for deleting the returned path after use.
 */
export function writeEnvFile(entries: Array<[string, string]>): string {
    const tmpFile = join(tmpdir(), `ccc-env-${randomBytes(6).toString("hex")}`);
    const lines: string[] = [];
    for (const [key, value] of entries) {
        if (value.includes("\n") || value.includes("\r") || value.includes("\0")) continue;
        lines.push(`${key}=${value}`);
    }
    writeFileSync(tmpFile, lines.join("\n") + "\n", { mode: 0o600 });
    return tmpFile;
}

/**
 * Interactive prompt helper
 * @param question - Question to ask
 * @param lowercase - If true, lowercase the answer (default: false)
 */
export async function prompt(question: string, lowercase: boolean = false): Promise<string> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise((resolve) => {
        rl.on("close", () => resolve(""));
        rl.question(question, (answer) => {
            const result = answer.trim();
            resolve(lowercase ? result.toLowerCase() : result);
            rl.close();
        });
    });
}
