import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

describe("shipped readiness core", () => {
    it("preserves source and embedded-package outcomes with explicit effect ports", () => {
        // A fresh build/assembly is required. Missing artifacts fail visibly.
        for (const path of ["application/start-readiness.mjs", "domain/readiness.mjs", "ports/readiness.mjs"]) {
            expect(readFileSync(join(repository, "dist/packages/device-lab/providers", path), "utf8"), path)
                .toBe(readFileSync(join(repository, "packages/device-lab/providers", path), "utf8"));
        }
        // Run Node's actual module resolver, without Vitest's workspace aliases.
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import assert from 'node:assert/strict';
            const modules = [
                './packages/device-lab/providers/application/start-readiness.mjs',
                './dist/packages/device-lab/providers/application/start-readiness.mjs',
            ];
            const runs = [];
            for (const path of modules) {
                const { waitForStartReadiness } = await import(path);
                const cases = [];
                for (const mode of ['ready', 'failure', 'late', 'throw', 'expired']) {
                    let time = mode === 'expired' ? 1000 : 0;
                    const trace = [];
                    const outcome = await waitForStartReadiness(1000, {
                        now: () => time,
                        sleep: async ms => { trace.push({ sleep: ms }); time += ms; },
                        probe: async budget => {
                            trace.push(budget);
                            if (mode === 'throw') throw new Error('PRIVATE');
                            if (mode === 'late') time = 1001;
                            return { ready: mode === 'ready' || mode === 'late', failed: mode === 'failure',
                                ...(mode === 'failure' ? { helper: { stage: 'response-timeout' } } : {}) };
                        },
                    });
                    cases.push({ mode, outcome, trace });
                }
                runs.push(cases);
            }
            assert.deepEqual(runs[0], runs[1]);
            assert.equal(runs[0][0].outcome.kind, 'ready');
            assert.equal(runs[0][4].trace.length, 0);
            assert.equal(JSON.stringify(runs).includes('PRIVATE'), false);
            console.log('source/embedded readiness parity PASS');
        `], { cwd: repository, encoding: "utf8", timeout: 10000, maxBuffer: 256 * 1024, windowsHide: true });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("source/embedded readiness parity PASS");
    });
});
