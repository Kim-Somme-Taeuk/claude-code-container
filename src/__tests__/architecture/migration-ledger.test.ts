import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { exportBoundaries, invariantAnchors, migrationPackets, migrationProvenance, packageBoundaries } from "./migration-ledger.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function source(path: string): string {
    const absolute = resolve(root, path);
    const local = relative(root, absolute);
    expect(isAbsolute(local) || local.startsWith("..")).toBe(false);
    expect(statSync(absolute).isFile(), path).toBe(true);
    return readFileSync(absolute, "utf8");
}
function exportedNames(text: string): Set<string> {
    const tree = ts.createSourceFile("anchor.ts", text, ts.ScriptTarget.Latest, true);
    const names = new Set<string>();
    for (const statement of tree.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const item of statement.exportClause.elements) names.add(item.name.text);
        }
        if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
            || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.add(statement.name.text);
    }
    return names;
}

describe("checked migration ledger (source inventory only)", () => {
    it("has exactly M00–M14 with acyclic, earlier prerequisites and honest status", () => {
        expect(migrationPackets.map(packet => packet.id)).toEqual(Array.from({ length: 15 }, (_, index) => `M${String(index).padStart(2, "0")}`));
        for (const [index, packet] of migrationPackets.entries()) {
            expect(packet.status).toBe(index === 0 ? "partial" : index === 1 ? "in-progress" : "pending/legacy");
            expect(new Set(packet.dependsOn).size).toBe(packet.dependsOn.length);
            for (const dependency of packet.dependsOn) expect(migrationPackets.slice(0, index).some(other => other.id === dependency), `${packet.id} -> ${dependency}`).toBe(true);
            expect(packet.sources.length).toBeGreaterThan(0);
            expect(packet.tests.length).toBeGreaterThan(0);
            expect(packet.nativeLanes.length).toBeGreaterThan(0);
        }
    });
    it("checks real source/test anchors and explicit exports without importing production", () => {
        for (const packet of migrationPackets) {
            for (const anchor of packet.sources) {
                const names = exportedNames(source(anchor.path));
                for (const name of anchor.exports) expect(names.has(name), `${anchor.path}: ${name}`).toBe(true);
            }
            for (const path of packet.tests) source(path);
        }
        for (const anchor of invariantAnchors) {
            const names = exportedNames(source(anchor.path));
            for (const name of anchor.exports) expect(names.has(name), `${anchor.concern}: ${name}`).toBe(true);
        }
    });
    it("records source entrypoints separately from unverified built targets", () => {
        for (const boundary of packageBoundaries) {
            const manifest = JSON.parse(source(boundary.manifest)) as { bin: Record<string, string> };
            expect(manifest.bin[boundary.bin]).toBe(boundary.target);
            source(boundary.source);
            for (const asset of boundary.assets) source(asset);
        }
        for (const boundary of exportBoundaries) {
            const manifest = JSON.parse(source(boundary.manifest)) as { exports: Record<string, unknown> };
            expect(manifest.exports[boundary.key]).toEqual(boundary.target);
        }
        expect(migrationProvenance.baselineCommit).toBe("2c90a3315536abef14c9c2737bb1e8742f129f25");
        expect(migrationProvenance.source.kind).toBe("candidate-worktree");
        expect(migrationProvenance.artifact.kind).toBe("unverified");
        expect(migrationProvenance.native.kind).toBe("unrun");
        expect(migrationProvenance.cutoverRequirement).toContain("not exhaustive");
    });
    it("recognizes declarations and aliases rather than comments or non-exported symbols", () => {
        expect([...exportedNames('// export function fake() {}\nfunction hidden() {}\nexport function real() {}\nexport { hidden as alias };\nexport const value = 1;')]).toEqual(["real", "alias", "value"]);
    });
});
