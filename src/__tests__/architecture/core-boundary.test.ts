import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations, type CoreBoundary } from "./core-boundary.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const boundaries: CoreBoundary[] = [
    { root: join(repository, "packages/device-lab/providers"), language: "mjs" },
    { root: join(repository, "src"), language: "ts" },
    { root: join(repository, "packages/device-lab/src/device-lab"), language: "ts" },
];
function filesUnder(directory: string, extension: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink()) throw new Error(`Linked core entry: ${entry.name}`);
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path, extension) : entry.name.endsWith(extension) ? [path] : [];
    });
}

describe("core layer dependency graph", () => {
    it("checks every migrated core file across all three source roots", () => {
        let checked = 0;
        for (const boundary of boundaries) for (const layer of ["domain", "ports", "application"]) {
            for (const file of filesUnder(join(boundary.root, layer), `.${boundary.language}`)) {
                expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, boundary), file).toEqual([]);
                checked++;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(3);
    });

    it.each([
        ["domain", 'import { f } from "../application/use-case.js";', false],
        ["domain", 'export type { Port } from "../ports/control.js";', false],
        ["domain", 'import { rule } from "./rule.js";', true],
        ["ports", 'import type { Fact } from "../domain/fact.js";', true],
        ["ports", 'export type { Port } from "./control.js";', true],
        ["ports", 'import { type Port } from "./control.js";', true],
        ["ports", 'import { Port } from "./control.js";', false],
        ["ports", 'import type { UseCase } from "../application/use-case.js";', false],
        ["application", 'import { rule } from "../domain/rule.js";', true],
        ["application", 'import type { Port } from "../ports/control.js";', true],
        ["application", 'import { rule } from "./nested/rule.js";', true],
        ["application", 'import { runtime } from "../composition/runtime.js";', false],
        ["application", 'export { f } from "../adapters/native.js";', false],
        ["application", 'export type { f } from "../adapters/native.js";', false],
        ["application", 'type Runtime = import("node:fs").Stats;', false],
        ["application", 'type Runtime = import("../adapters/native.js").Runtime;', false],
        ["application", 'import x = require("node:fs");', false],
        ["application", 'import type { ReadinessPorts } from "@ccc/device-lab/providers/ports/readiness.mjs";', false],
        ["application", 'import { f } from "../../application/foreign.js";', false],
        ["application", 'export * from "../domain/rule.js?loader=effect";', false],
    ] as const)("%s: %s (allowed=%s)", (layer, source, allowed) => {
        const boundary = boundaries[1];
        expect(coreBoundaryViolations(source, join(boundary.root, layer, "sample.ts"), boundary).length === 0).toBe(allowed);
    });

    it("rejects a real existing backend path from application and application from domain", () => {
        const boundary = boundaries[0];
        expect(existsSync(join(boundary.root, "backends/windows-sandbox.mjs"))).toBe(true);
        expect(coreBoundaryViolations('export * from "../backends/windows-sandbox.mjs";',
            join(boundary.root, "application/sample.mjs"), boundary)).not.toEqual([]);
        expect(coreBoundaryViolations('import { waitForStartReadiness } from "../application/start-readiness.mjs";',
            join(boundary.root, "domain/sample.mjs"), boundary)).not.toEqual([]);
    });

    it.each([
        'const { random } = Math; random();',
        'const rng = Math; rng.random();',
        'Reflect.get(Math, "random")();',
        'Math.constructor("return process")();',
    ])("rejects indirect ambient randomness: %s", source => {
        const boundary = boundaries[0];
        expect(coreBoundaryViolations(source, join(boundary.root, "application/sample.mjs"), boundary)).not.toEqual([]);
    });

    it("permits direct pure Math operations", () => {
        const boundary = boundaries[0];
        expect(coreBoundaryViolations('const cap = Math.min(10000, Math.max(0, 20));',
            join(boundary.root, "application/sample.mjs"), boundary)).toEqual([]);
    });
});
