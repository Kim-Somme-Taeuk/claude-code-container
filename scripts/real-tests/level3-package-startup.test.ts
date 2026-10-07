import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { deviceLabTestHomeEnvironment } from "../../src/__tests__/helpers/device-lab-test-environment.js";
import { realProviderTempRoot, repoRoot } from "./helpers.ts";
import { buildLevel3Artifacts } from "./support/level3-host.ts";

describe("Level 3 packaged MCP startup", () => {
    it("initializes and lists tools from the emitted Level 3 ESM bundle", { timeout: 60000 }, async () => {
        // Before assembly the bundle resolves workspace package metadata. Keep
        // that resolution available; package tests cover the assembled relocation.
        const temporary = mkdtempSync(join(realProviderTempRoot(), "ccc-level3-mcp-startup-"));
        const serverPath = join(temporary, "server.mjs");
        const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
            && !/^(CCC_|ANDROID_|VITEST)/i.test(key) && !["NODE_OPTIONS", "NODE_PATH"].includes(key))) as Record<string, string>;
        Object.assign(env, deviceLabTestHomeEnvironment(temporary), { CCC_DEVICE_BROKER_AUTO_START: "0" });
        const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
            cwd: temporary, env, stderr: "pipe" });
        const client = new Client({ name: "level3-package-startup-regression", version: "1" }, { capabilities: {} });
        let stderr = "";
        let buildError = "";
        let bundles = 0;
        try {
            const status = buildLevel3Artifacts(repoRoot, {
                env,
                platform: "linux",
                // Compile/assembly stages have their own coverage. Run the real MCP
                // build chosen by Level 3, redirecting only its output to avoid shared dist.
                spawn: (command: string, args: string[], options: any) => {
                    if (args[0] !== join(repoRoot, "device-lab-mcp", "scripts", "build.mjs")) return { status: 0 };
                    bundles++;
                    const isolatedArgs = args.map((arg, index) => arg.startsWith("--outfile=")
                        ? `--outfile=${serverPath}` : args[index - 1] === "--outfile" ? serverPath : arg);
                    return spawnSync(command, isolatedArgs, { ...options, timeout: 30000 });
                },
                readFile: (path: string) => path.endsWith("package.json") ? readFileSync(path, "utf8") : "__CLI_VERSION__",
                writeFile: () => undefined,
                writeError: (message: string) => { buildError += message; },
            });
            expect(status, buildError).toBe(0);
            expect(bundles).toBe(1);

            transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
            try {
                await client.connect(transport, { timeout: 10000 });
                expect(client.getServerVersion()?.name).toBe("device-lab-mcp");
                const listed = await client.listTools({}, { timeout: 10000 });
                expect(listed.nextCursor).toBeUndefined();
                expect(listed.tools.map(tool => tool.name).sort()).toEqual(TOOLS.map(tool => tool.name).sort());
                await client.ping({ timeout: 10000 });
            } catch (error) {
                throw new Error(`Emitted MCP startup failed: ${String(error)}\n${stderr}`, { cause: error });
            }
        } finally {
            await client.close();
            await transport.close();
            rmSync(temporary, { recursive: true, force: true });
        }
    });
});
