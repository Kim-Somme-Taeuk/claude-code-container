import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coreBoundaryViolations } from "./architecture/core-boundary.js";
import { describe, expect, it } from "vitest";

const applicationRoot = fileURLToPath(new URL("../../packages/device-lab/providers/application/", import.meta.url));
const boundary = { root: resolve(applicationRoot, '..'), language: 'mjs' as const };
const violations = (source: string, file = join(applicationRoot, "sample.mjs")) =>
    coreBoundaryViolations(source, file, boundary);

function applicationFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink()) throw new Error("Application source must not use symlink entries");
        const path = join(directory, entry.name);
        return entry.isDirectory() ? applicationFiles(path) : entry.name.endsWith(".mjs") ? [path] : [];
    });
}

describe("device-lab application dependency boundary", () => {
    it("keeps all application modules independent of adapters and ambient runtime effects", () => {
        const files = applicationFiles(applicationRoot);
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) expect(violations(readFileSync(file, "utf8"), file), file).toEqual([]);
    });

    it.each([
        'import fs from "node:fs";', 'export * from "../backends/windows-sandbox.mjs";',
        'import x from "/tmp/x.mjs";', 'import("./local.mjs");', 'require("node:fs");',
        'const load = require; load("node:fs");', 'process.env.HOME;', 'Date.now();',
        'new Date();', 'setTimeout(() => {}, 1);', 'fetch("https://example.test");',
        'globalThis["process"];', 'performance.now();', 'Math.random();', 'Math["random"]();',
        'new Function("return process")();', 'import.meta.url;',
        '/** @typedef {import("../backends/windows-sandbox.mjs").Clock} Clock */ export {};',
        '/** @import {Clock} from "node:timers" */ export {};',
    ])("rejects forbidden dependency: %s", source => {
        expect(violations(source)).not.toEqual([]);
    });

    it("allows local imports, pure built-ins and explicit ports without matching comments or strings", () => {
        expect(violations(`
            import { normalize } from "./observations.mjs";
            export { normalize } from "./observations.mjs";
            // process.env and Date.now are not code here.
            const description = "fetch globalThis require";
            export async function poll({ probe, now, sleep }, observation) {
                const remaining = Math.max(0, observation.deadline - now());
                await sleep(remaining);
                return { description, process: observation.process, result: await probe(remaining) };
            }
        `)).toEqual([]);
    });
});
