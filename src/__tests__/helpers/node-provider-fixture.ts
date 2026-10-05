import childProcess, { type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";

/** Run fixture Node scripts as actual subprocesses on every host, without shell or PATHEXT dependence. */
export function installNodeProviderFixtureRouting(binDir: string): () => void {
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;
    const root = resolve(binDir);
    function isNodeFixture(command: string): boolean {
        if (dirname(resolve(command)) !== root || !existsSync(command)) return false;
        return /^#!.*(?:node|node\.exe)(?:\r?\n|$)/.test(readFileSync(command, "utf8").split("\n", 1)[0]);
    }
    childProcess.spawnSync = ((command: string, argsOrOptions: string[] | SpawnSyncOptions = [], suppliedOptions: SpawnSyncOptions = {}) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        const options = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
        const lookup = command === "where" ? args[0]
            : command === "/bin/sh" && args[0] === "-c" && args[1]?.startsWith("command -v ") ? args[1].slice(11) : undefined;
        if (lookup && /^[\w.+-]+$/.test(lookup)) {
            const candidate = join(root, lookup);
            const found = isNodeFixture(candidate);
            const stdout = found ? candidate + "\n" : "";
            return { status: found ? 0 : 1, signal: null, pid: 0, stdout, stderr: "", output: [null, stdout, ""] };
        }
        return isNodeFixture(command) ? originalSpawnSync(process.execPath, [command, ...args], options)
            : originalSpawnSync(command, args, options);
    }) as typeof childProcess.spawnSync;
    childProcess.spawn = ((command: string, argsOrOptions: string[] | SpawnOptions = [], suppliedOptions: SpawnOptions = {}) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        const options = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
        return isNodeFixture(command) ? originalSpawn(process.execPath, [command, ...args], options)
            : originalSpawn(command, args, options);
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    return () => {
        childProcess.spawn = originalSpawn;
        childProcess.spawnSync = originalSpawnSync;
        syncBuiltinESMExports();
    };
}

/** Equivalent routing inside a stdio MCP child, before its native ESM imports load. */
export function nodeProviderFixturePreloadSource(binDir: string): string {
    return `const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = ${JSON.stringify(resolve(binDir))};
const originalSpawn = cp.spawn, originalSpawnSync = cp.spawnSync;
function isFixture(command) {
    if (path.dirname(path.resolve(command)) !== root || !fs.existsSync(command)) return false;
    return /^#!.*(?:node|node\\.exe)(?:\\r?\\n|$)/.test(fs.readFileSync(command, 'utf8').split('\\n', 1)[0]);
}
cp.spawnSync = function(command, argsOrOptions = [], suppliedOptions = {}) {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
    const lookup = command === 'where' ? args[0] : command === '/bin/sh' && args[0] === '-c' && args[1]?.startsWith('command -v ') ? args[1].slice(11) : undefined;
    if (lookup && /^[\\w.+-]+$/.test(lookup)) {
        const candidate = path.join(root, lookup), found = isFixture(candidate), stdout = found ? candidate + '\\n' : '';
        return { status: found ? 0 : 1, signal: null, pid: 0, stdout, stderr: '', output: [null, stdout, ''] };
    }
    return isFixture(command) ? originalSpawnSync(process.execPath, [command, ...args], options) : originalSpawnSync(command, args, options);
};
cp.spawn = function(command, argsOrOptions = [], suppliedOptions = {}) {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions;
    return isFixture(command) ? originalSpawn(process.execPath, [command, ...args], options) : originalSpawn(command, args, options);
};
require('node:module').syncBuiltinESMExports();\n`;
}
