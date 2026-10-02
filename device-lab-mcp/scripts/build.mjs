import { build } from "esbuild-wasm";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outfile" || !args[1])) {
    throw new Error("Usage: node device-lab-mcp/scripts/build.mjs [--outfile <path relative to cwd>]");
}

// The workspace build defaults to its own dist; root and Level 3 builds choose
// their destination explicitly, while sharing the CommonJS bridge needed by pngjs.
await build({
    absWorkingDir: packageRoot,
    entryPoints: ["server.mjs"],
    outfile: args.length ? resolve(args[1]) : join(packageRoot, "dist", "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
        js: "// device-lab-mcp-version: 1\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
});
