import {build} from "esbuild-wasm";
import {fileURLToPath} from "node:url";
await build({absWorkingDir:fileURLToPath(new URL("../",import.meta.url)),entryPoints:["server.mjs"],outfile:"dist/server.mjs",bundle:true,platform:"node",format:"esm",banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
