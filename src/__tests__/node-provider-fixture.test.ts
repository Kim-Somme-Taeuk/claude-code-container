import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installNodeProviderFixtureRouting, nodeProviderFixturePreloadSource } from "./helpers/node-provider-fixture.js";

it("routes live Node fixture rewrites and both lookup forms without requiring shell executables", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ccc-node-fixture-"));
    const file = join(bin, "provider");
    writeFileSync(file, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`);
    const restore = installNodeProviderFixtureRouting(bin);
    try {
        for (const [command, args] of [["where", ["provider"]], ["/bin/sh", ["-c", "command -v provider"]]] as const) {
            expect(spawnSync(command, [...args], { encoding: "utf8" }).stdout.trim()).toBe(file);
        }
        expect(spawnSync("where", ["missing-provider"], { encoding: "utf8" }).status).toBe(1);
        expect(JSON.parse(spawnSync(file, ["a b", "한글", '"quoted"'], { encoding: "utf8" }).stdout)).toEqual(["a b", "한글", '"quoted"']);
        writeFileSync(file, `#!${process.execPath}\nconsole.log('rewritten'); process.exit(7);`);
        const child = spawn(file, [], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout!.on("data", chunk => { output += chunk; });
        const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
        expect(status).toBe(7);
        expect(output.trim()).toBe("rewritten");
    } finally { restore(); rmSync(bin, { recursive: true, force: true }); }
});

it("preloads portable fixture routing before a child imports native ESM subprocess functions", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-node-preload-"));
    const file = join(root, "provider");
    const preload = join(root, "routing.cjs");
    writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    writeFileSync(preload, nodeProviderFixturePreloadSource(root));
    try {
        const result = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", `
            import { spawnSync } from 'node:child_process';
            const win = spawnSync('where', ['provider'], { encoding: 'utf8' });
            const posix = spawnSync('/bin/sh', ['-c', 'command -v provider'], { encoding: 'utf8' });
            if (win.stdout !== posix.stdout || win.status !== 0) process.exit(10);
            const child = spawnSync(win.stdout.trim(), ['a b', '한글', 'C:\\\\path'], { encoding: 'utf8' });
            process.stdout.write(child.stdout); process.exitCode = child.status;
        `], { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(["a b", "한글", "C:\\path"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
