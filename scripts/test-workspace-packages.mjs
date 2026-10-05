import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assembleWorkspaceRuntime } from "./workspace-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "ccc-workspace-package-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith("CCC_") && !name.startsWith("VITEST") && !["NODE_PATH", "NODE_OPTIONS"].includes(name)));
Object.assign(env, { HOME: temporary, USERPROFILE: temporary, CCC_DEVICE_BROKER_AUTO_START: "0" });

function run(executable, args, cwd = temporary) {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 120000,
        maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, String(result.error || result.stderr || "distribution command failed").slice(0, 2000));
    return result.stdout;
}

async function mcpSmoke(packageRoot, serverName) {
    const child = spawn(process.execPath, [join(packageRoot, `dist/${serverName}/server.mjs`)], {
        cwd: temporary, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    let output = "";
    let stderr = "";
    let sequence = 0;
    let failure;
    const pending = new Map();
    function fail(error) {
        failure = error;
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    }
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", code => fail(new Error(`packaged MCP exited ${code}: ${stderr.slice(0, 1000)}`)));
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.setEncoding("utf8").on("data", chunk => {
        output += chunk;
        if (output.length > 4 * 1024 * 1024) return fail(new Error("packaged MCP output limit exceeded"));
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
            const line = output.slice(0, newline); output = output.slice(newline + 1);
            if (!line.trim()) continue;
            let response;
            try { response = JSON.parse(line); } catch { fail(new Error("packaged MCP emitted invalid JSON")); return; }
            const entry = pending.get(response.id);
            if (entry) {
                pending.delete(response.id);
                if (response.error) entry.reject(new Error(`packaged MCP RPC failed: ${response.error.code}`));
                else entry.resolve(response.result);
            }
        }
    });
    function request(method, params = {}) {
        if (failure) return Promise.reject(failure);
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) fail(error); });
        });
    }
    const timer = setTimeout(() => fail(new Error("packaged MCP smoke timed out")), 30000);
    try {
        const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "ccc-workspace-distribution-smoke", version: "1" } });
        assert.equal(initialized.serverInfo.name, serverName);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listed = await request("tools/list");
        assert.ok(Array.isArray(listed.tools) && listed.tools.some(tool => tool.name === "screenshot"));
        if (serverName === "device-lab-mcp") assert.ok(listed.tools.some(tool => tool.name === "create_windows_vm"));
        await request("ping");
    } finally {
        clearTimeout(timer);
        child.stdin.end();
        if (child.exitCode === null) child.kill();
        let shutdownTimer;
        try {
            await Promise.race([closed, new Promise((_, reject) => {
                shutdownTimer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("packaged MCP did not stop"));
                }, 5000);
            })]);
        } finally { clearTimeout(shutdownTimer); }
    }
}

async function smoke(packageRoot) {
    assert.equal(existsSync(join(packageRoot, "node_modules")), false);
    assert.equal(existsSync(join(packageRoot, "x11-mcp")), false, "standalone X11 source was distributed");
    assert.equal(existsSync(join(packageRoot, "dist/x11-mcp")), false, "obsolete X11 bundle was distributed");
    run(process.execPath, [join(packageRoot, "dist/index.js"), "--version"]);
    assert.match(run(process.execPath, [join(packageRoot, "dist/index.js"), "--help"]), /ccc/i);
    const core = pathToFileURL(join(packageRoot, "dist/packages/device-lab/dist/device-lab-broker.js")).href;
    const hyperV = pathToFileURL(join(packageRoot, "dist/packages/hyper-v/dist/index.js")).href;
    const transport = pathToFileURL(join(packageRoot, "dist/packages/hyper-v/dist/low-level/powershell-transport.js")).href;
    run(process.execPath, ["--input-type=module", "-e", [
        `const core=await import(${JSON.stringify(core)});`,
        "if(typeof core.createDeviceBrokerServer!=='function')throw Error('broker export missing');",
        `const hyperV=await import(${JSON.stringify(hyperV)});`,
        "if(typeof hyperV.createHyperVWindowsClient!=='function')throw Error('Hyper-V export missing');",
        `const transport=await import(${JSON.stringify(transport)});`,
        "const asset=transport.verifiedOperationAsset();if(!asset.scriptSource)throw Error('PowerShell asset missing');",
    ].join("\n")]);
    await mcpSmoke(packageRoot, "device-lab-mcp");
}

try {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("Run this verification through npm so npm_execpath is available.");
    // Exercise incremental cleanup and packaging in an isolated checkout. Never
    // seed or assemble active dist artifacts while another suite is using them.
    const fixture = join(temporary, "checkout");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    mkdirSync(fixture);
    for (const path of new Set(["package.json", "README.md", "LICENSE", "packages", ...manifest.files])) {
        const source = join(root, path);
        if (!existsSync(source)) continue;
        const destination = join(fixture, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { recursive: true,
            filter: candidate => !relative(source, candidate).split(sep).includes("node_modules") });
    }
    const obsolete = join(fixture, "dist/x11-mcp");
    mkdirSync(obsolete, { recursive: true });
    writeFileSync(join(obsolete, "server.mjs"), "throw Error('obsolete X11 bundle survived');\n");
    const preserved = join(fixture, "dist/incremental-preservation.txt");
    writeFileSync(preserved, "unrelated generated output\n");
    const deviceLabBundle = readFileSync(join(fixture, "dist/device-lab-mcp/server.mjs"));
    assembleWorkspaceRuntime(fixture);
    assert.equal(existsSync(obsolete), false, "incremental assembly retained the obsolete X11 bundle");
    assert.equal(readFileSync(preserved, "utf8"), "unrelated generated output\n");
    assert.deepEqual(readFileSync(join(fixture, "dist/device-lab-mcp/server.mjs")), deviceLabBundle);
    rmSync(preserved);
    const report = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], fixture));
    const reports = Array.isArray(report) ? report : Object.values(report);
    assert.equal(reports.length, 1, "expected one packed workspace distribution");
    const [packedReport] = reports;
    const filename = packedReport?.filename;
    assert.ok(typeof filename === "string" && /^[A-Za-z0-9._-]+\.tgz$/.test(filename));
    assert.ok(Array.isArray(packedReport.files), "npm pack did not report package files");
    assert.ok(packedReport.files.every(({ path }) => !/^(?:dist\/)?x11-mcp(?:\/|$)/.test(path)),
        "npm package contains standalone X11 artifacts");
    run(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", join(temporary, filename), "-C", temporary]);
    const packed = join(temporary, "package");
    await smoke(packed);
    const installed = join(temporary, "unix-install");
    const installer = pathToFileURL(join(packed, "scripts/install.js")).href;
    run(process.execPath, ["--input-type=module", "-e",
        `const {materializeUnixInstallPayload}=await import(${JSON.stringify(installer)});materializeUnixInstallPayload(${JSON.stringify(packed)},${JSON.stringify(installed)});`]);
    await smoke(installed);
    console.log("PASS workspace distribution: obsolete X11 output removed; extracted npm package and materialized install CLI, broker, Hyper-V assets, Device Lab MCP");
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
