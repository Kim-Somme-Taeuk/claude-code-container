// src/container-setup.ts - In-container setup and binary management
//
// Extracted from index.ts for separation of concerns.
// Contains: claude binary caching, npm tools installation, mise shim detection.

import { spawnSync, type SpawnSyncReturns } from "child_process";
import { getNpmTools, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { runtimeCli } from "./container-runtime.js";
import { prepareOpenCodeDataDirectory } from "./opencode-data-access.js";

// Claude binary persist path inside the mise volume
export const CLAUDE_PERSIST_DIR = "/home/ccc/.local/share/mise/.claude-bin";
export const CLAUDE_EXECUTABLE = "claude";
export const CLAUDE_BIN_PATH = "/home/ccc/.local/bin/claude";

export function isClaudeVersionLine(line: string): boolean {
    const trimmed = line.trim();
    return /^(claude(\s+code)?\s+v?\d+\.\d+\.\d+|v?\d+\.\d+\.\d+(\s|$)|v?\d+\.\d+\.\d+.*\bclaude(\s+code)?\b)/i.test(trimmed);
}

/**
 * Check if a file in the container is a mise shim (shell script referencing mise)
 * rather than a real native binary.
 */
export function isMiseShim(containerName: string, path: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", `head -c 500 '${path.replace(/'/g, "'\\''")}' 2>/dev/null | grep -q mise`],
        { encoding: "utf-8" },
    );
    return result.status === 0;
}

/**
 * Verify the binary at the given path is actually claude by checking --version output.
 * Guards against bun or other binaries accidentally cached at the claude path.
 */
export function isValidClaudeBinary(containerName: string, path: string): boolean {
    const escapedPath = path.replace(/'/g, "'\\''");
    const result = spawnSync(
        runtimeCli(),
        [
            "exec", containerName, "sh", "-c",
            `first_line="$('${escapedPath}' --version 2>/dev/null | head -n 1 || true)"; printf '%s\\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\\bclaude([[:space:]]+code)?\\b)'`,
        ],
        { encoding: "utf-8", timeout: 10000 },
    );
    return result.status === 0;
}

/**
 * Ensure claude binary is available in the container.
 * 1. If real claude binary exists at known path → do nothing
 * 2. If claude exists elsewhere on PATH → copy it into the fixed path + cache
 * 3. If volume has a valid cached copy → restore it to the fixed path
 * 4. Otherwise → fresh install, then copy into fixed path + cache
 *
 * Uses a single docker exec to probe both paths, reducing round-trips
 * from 3-5 to 1 for the common happy path.
 */
export function ensureClaudeInContainer(containerName: string): void {
    // Single docker exec: check main path, fall through to cache, handle cleanup
    const probeScript = `
BIN="${CLAUDE_BIN_PATH}"
CACHE="${CLAUDE_PERSIST_DIR}/claude"
FOUND="$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)"
is_shim() { head -c 500 "$1" 2>/dev/null | grep -q mise; }
is_claude() {
  first_line="$("$1" --version 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$first_line" | grep -Eiq '^(claude([[:space:]]+code)?[[:space:]]+v?[0-9]+[.][0-9]+[.][0-9]+|v?[0-9]+[.][0-9]+[.][0-9]+([[:space:]]|$)|v?[0-9]+[.][0-9]+[.][0-9]+.*\bclaude([[:space:]]+code)?\b)'
}

if [ -x "$BIN" ]; then
  if is_shim "$BIN"; then
    rm -f "$BIN"
  elif is_claude "$BIN"; then
    echo VALID; exit 0
  else
    rm -f "$BIN"
  fi
fi
if [ -n "$FOUND" ] && [ -x "$FOUND" ]; then
  if is_shim "$FOUND"; then
    :
  elif is_claude "$FOUND"; then
    mkdir -p "$(dirname "$BIN")" "$(dirname "$CACHE")" && cp -L "$FOUND" "$CACHE" && cp -L "$CACHE" "$BIN"
    echo VALID; exit 0
  fi
fi
if [ -x "$CACHE" ]; then
  if is_shim "$CACHE"; then
    rm -f "$CACHE"
  elif is_claude "$CACHE"; then
    mkdir -p "$(dirname "$BIN")" && cp -L "$CACHE" "$BIN"
    echo RESTORED; exit 0
  else
    rm -f "$CACHE"
  fi
fi
echo INSTALL`.trim();

    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", probeScript],
        { encoding: "utf-8", timeout: 15000 },
    );
    const status = (result.stdout ?? "").trim();

    if (status === "VALID") return;

    if (status === "RESTORED") {
        console.log("Restored claude from cache.");
        return;
    }

    // Fresh install and save to volume
    console.log("Installing claude (first run)...");
    const installResult = spawnSync(
        runtimeCli(),
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `${getToolByName("claude")!.installCommand} && ACTUAL="$(command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true)" && [ -n "$ACTUAL" ] && [ -x "$ACTUAL" ] && mkdir -p ${CLAUDE_PERSIST_DIR} "$(dirname ${CLAUDE_BIN_PATH})" && cp -L "$ACTUAL" ${CLAUDE_PERSIST_DIR}/claude && cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH}`,
        ],
        { stdio: "inherit" },
    );
    if (installResult.status !== 0) {
        throw new Error("Failed to install claude in container");
    }
}

/**
 * Ensure all required tools are installed in the container.
 * - Claude: curl install + volume caching (only when activeTool is claude)
 * - npm tools (gemini, codex, opencode): npm install -g from registry
 */
export function ensureTools(
    containerName: string,
    activeTool: ToolDefinition,
    options: { activeOnly?: boolean } = {},
): void {
    if (activeTool.name === "claude") {
        ensureClaudeInContainer(containerName);
    }
    ensureNpmTools(containerName, activeTool, options.activeOnly ?? false);
}

function npmSetupFailureReason(result: SpawnSyncReturns<string | Buffer>): string {
    return result.error?.message
        || result.stderr?.toString().trim()
        || (result.signal ? `terminated by ${result.signal}` : `exit code ${result.status ?? "unknown"}`);
}

/**
 * Ensure npm-based tools from registry are installed independently.
 */
function ensureNpmTools(containerName: string, activeTool: ToolDefinition, activeOnly: boolean): void {
    const tools = getNpmTools().filter((tool) => !activeOnly || tool.cmd === activeTool.name);
    if (tools.length === 0) return;

    // Single docker exec to check all relevant tools at once.
    const checkResult = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c",
         tools.map((t) => `[ -x /home/ccc/.local/bin/${t.cmd} ] || echo ${t.cmd}`).join("; ")],
        { encoding: "utf-8" },
    );
    if (checkResult.error || checkResult.status !== 0) {
        throw new Error(`Failed to check npm tool readiness for ${activeTool.name} in container: ${npmSetupFailureReason(checkResult)}`);
    }
    const missingCmds = new Set((checkResult.stdout ?? "").trim().split("\n").filter(Boolean));
    let missing = tools.filter((t) => missingCmds.has(t.cmd));

    // OpenCode's version probe creates data directories even during postinstall.
    // Prepare active installations too, including already-present wrappers.
    if (activeTool.name === "opencode" || missing.some((tool) => tool.cmd === "opencode")) {
        try {
            prepareOpenCodeDataDirectory(containerName);
        } catch (error) {
            if (activeTool.name === "opencode") throw error;
            console.warn(`Warning: ${error instanceof Error ? error.message : String(error)} (optional tool)`);
            missing = missing.filter((tool) => tool.cmd !== "opencode");
        }
    }

    if (missing.length === 0) {
        return;
    }

    const run = (script: string, stdio: "ignore" | "inherit" | "pipe", timeout?: number) => spawnSync(
        runtimeCli(),
        ["exec", "-w", "/home/ccc", containerName, "sh", "-c", script],
        { stdio, ...(timeout === undefined ? {} : { timeout }) },
    );

    let activeFailure: Error | undefined;
    const reportFailure = (cmd: string, failure: Error): void => {
        if (cmd === activeTool.name) activeFailure = failure;
        else console.warn(`Warning: ${failure.message} (optional tool)`);
    };
    const cached = new Set<string>();
    const probeFailed = new Set<string>();
    for (const t of missing) {
        // Resolve locally, then run the actual global binary, never a PATH shim
        // or our missing wrapper. Bound the process inside the container too:
        // killing a timed-out docker exec client alone leaves its process alive.
        const probe = run(`if [ ! -x /usr/bin/timeout ]; then echo "Tool verification requires timeout" >&2; exit 1; fi
[ -x ~/.local/bin/mise ] || { echo "mise is unavailable for tool verification" >&2; exit 1; }
node_installed=false
for node_binary in "\${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/node/22.*/bin/node; do
    if [ -x "$node_binary" ]; then node_installed=true; break; fi
done
if [ "$node_installed" = false ]; then echo MISSING; exit 0; fi
node_dir=$(MISE_OFFLINE=1 /usr/bin/timeout -k 1s 3s ~/.local/bin/mise where node@22) || exit $?
[ -x "$node_dir/bin/node" ] || { echo "Installed Node 22 binary is unavailable" >&2; exit 1; }
if [ ! -x "$node_dir/bin/${t.cmd}" ]; then echo MISSING; exit 0; fi
PATH="$node_dir/bin:$PATH" /usr/bin/timeout -k 1s 10s "$node_dir/bin/${t.cmd}" --version >/dev/null
status=$?
case "$status" in
    0) echo READY ;;
    124) echo "Timed out verifying persisted ${t.cmd}" >&2; exit "$status" ;;
    137) echo "Verification of persisted ${t.cmd} was killed (exit 137)" >&2; exit "$status" ;;
    *) echo MISSING ;;
esac`, "pipe", 15_000);
        const state = probe.stdout?.toString().trim();
        if (probe.error || probe.status !== 0 || (state !== "READY" && state !== "MISSING")) {
            probeFailed.add(t.cmd);
            reportFailure(t.cmd, new Error(`Failed to verify persisted ${t.cmd} (${t.pkg}) in container: ${
                probe.error || probe.status !== 0 ? npmSetupFailureReason(probe) : "unexpected verification output"
            }`));
        } else if (state === "READY") {
            cached.add(t.cmd);
        }
    }

    const needsInstall = missing.filter((t) => !cached.has(t.cmd) && !probeFailed.has(t.cmd));
    if (needsInstall.length > 0) {
        console.log(`Installing ${needsInstall.map((t) => t.cmd).join(", ")}...`);
        const cleanupPatterns = needsInstall.map((t) => {
            const name = t.pkg.split("/").pop();
            const scope = t.pkg.includes("/") ? t.pkg.split("/")[0] + "/" : "";
            return `"$gdir/${scope}.${name}-"*`;
        }).join(" ");

        run(
            `gdir=$(~/.local/bin/mise exec node@22 -- npm root -g 2>/dev/null) && rm -rf ${cleanupPatterns} 2>/dev/null; true`,
            "ignore",
        );

        // Drop stale shims only for packages requiring installation. Healthy
        // persisted packages need their wrapper restored without cache changes.
        const shimNuke = needsInstall.map((t) => `rm -f ~/.local/share/mise/shims/${t.cmd}`).join("; ");
        run(`${shimNuke}; true`, "ignore");
    }

    let installedAny = false;
    for (const t of missing) {
        if (probeFailed.has(t.cmd)) continue;
        let failure: Error | undefined;
        if (!cached.has(t.cmd)) {
            const installResult = run(`~/.local/bin/mise exec node@22 -- npm install -g ${t.pkg}`, "inherit");
            if (installResult.error || installResult.status !== 0) {
                failure = new Error(`Failed to install ${t.cmd} (${t.pkg}) in container: ${npmSetupFailureReason(installResult)}`);
            } else {
                installedAny = true;
            }
        }
        if (!failure) {
            // A failed write or chmod must not leave an executable broken wrapper.
            const wrapperResult = run(
                `if cat > /home/ccc/.local/bin/${t.cmd} << 'WRAPPER'\n#!/bin/sh\nexec ~/.local/bin/mise exec node@22 -- ${t.cmd} "$@"\nWRAPPER\nthen\n    chmod +x /home/ccc/.local/bin/${t.cmd} && exit 0\nfi\nrm -f /home/ccc/.local/bin/${t.cmd}\nexit 1`,
                "pipe",
            );
            if (wrapperResult.error || wrapperResult.status !== 0) {
                failure = new Error(`Failed to create wrapper for ${t.cmd} (${t.pkg}) in container: ${npmSetupFailureReason(wrapperResult)}`);
            }
        }
        if (failure) {
            reportFailure(t.cmd, failure);
        }
    }

    // Refresh shims for every successful package, even if another tool failed.
    if (installedAny) {
        run("~/.local/bin/mise reshim 2>/dev/null; true", "ignore");
    }
    if (activeFailure) throw activeFailure;
}

/**
 * Save claude binary back to volume and refresh the fixed install path.
 */
export function saveClaudeBinaryToVolume(containerName: string): void {
    const resolveResult = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", `command -v ${CLAUDE_EXECUTABLE} 2>/dev/null || true`],
        { encoding: "utf-8", timeout: 10000 },
    );
    const actualPath = (resolveResult.stdout ?? "").trim() || CLAUDE_BIN_PATH;

    if (isMiseShim(containerName, actualPath)) {
        return;
    }
    if (!isValidClaudeBinary(containerName, actualPath)) {
        return;
    }
    spawnSync(
        runtimeCli(),
        [
            "exec",
            containerName,
            "sh",
            "-c",
            `mkdir -p ${CLAUDE_PERSIST_DIR} "$(dirname ${CLAUDE_BIN_PATH})" && [ -x '${actualPath.replace(/'/g, "'\\''")}' ] && cp -L '${actualPath.replace(/'/g, "'\\''")}' ${CLAUDE_PERSIST_DIR}/claude && cp -L ${CLAUDE_PERSIST_DIR}/claude ${CLAUDE_BIN_PATH} || true`,
        ],
        { stdio: "ignore" },
    );
}

/**
 * Ensure uv is available globally in the container via mise.
 * uv is used by hooks (e.g. ~/.claude/hooks/langfuse-claudecode) which run
 * without bash profile activation — they rely on the global mise shim.
 */
export function ensureUvAvailable(containerName: string): void {
    const checkResult = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c",
         "~/.local/bin/mise ls --global 2>/dev/null | grep -q '^uv '"],
        { encoding: "utf-8" },
    );
    if (checkResult.status === 0) return;

    process.stderr.write("\x1b[2m▸ Installing uv (one-time, ~30-60s)...\x1b[0m\n");
    // MISE_VERBOSE=1 forces mise to stream download/build progress so the user
    // sees activity instead of a silent stall during the install.
    spawnSync(
        runtimeCli(),
        ["exec", "-e", "MISE_VERBOSE=1", containerName, "sh", "-c",
         "~/.local/bin/mise use -g uv@latest"],
        { stdio: "inherit" },
    );
}
