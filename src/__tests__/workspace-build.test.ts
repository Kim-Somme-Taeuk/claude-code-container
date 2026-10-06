import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWorkspacePackages } from "../../scripts/workspace-build.mjs";

const roots: string[] = [];
const repository = fileURLToPath(new URL("../../", import.meta.url));
const linkType = process.platform === "win32" ? "junction" : "dir";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc workspace build "));
    roots.push(root);
    const modules = join(root, "node_modules");
    mkdirSync(modules);
    symlinkSync(realpathSync(join(repository, "node_modules", "typescript")), join(modules, "typescript"), linkType);
    for (const name of ["hyper-v", "device-lab"]) {
        const pkg = join(root, "packages", name);
        mkdirSync(join(pkg, "src"), { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({
            name: `@ccc/${name}`, type: "module",
            exports: { "./*.js": { types: "./dist/*.d.ts", import: "./dist/*.js" } },
        }));
        writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
                rootDir: "src", outDir: "dist", declaration: true, strict: true, skipLibCheck: true },
            include: ["src/**/*.ts"],
        }));
    }
    for (const [file, value] of [["index", 1], ["lifecycle/index", 2], ["low-level/index", 3]] as const) {
        const source = join(root, "packages", "hyper-v", "src", `${file}.ts`);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, `export const value = ${value};\n`);
    }
    writeFileSync(join(root, "packages", "device-lab", "src", "index.ts"), [
        'import {value as a} from "@ccc/hyper-v/index.js";',
        'import {value as b} from "@ccc/hyper-v/lifecycle/index.js";',
        'import {value as c} from "@ccc/hyper-v/low-level/index.js";',
        'export const total = a + b + c;',
    ].join("\n"));
    return root;
}

function scope(root: string) { return join(root, "node_modules", "@ccc"); }
function source(root: string, name = "hyper-v") { return join(root, "packages", name); }
function link(root: string, name = "hyper-v") { return join(scope(root), name); }
function expectConsumer(root: string) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
        'import {total} from "@ccc/device-lab/index.js"; if(total!==6)throw Error("wrong workspace");'],
    { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
}

describe("portable runtime workspace build", () => {
    it("creates missing scope/links and resolves every reported subpath with real TypeScript and Node", () => {
        const root = fixture();
        buildWorkspacePackages(root);
        expect(realpathSync(link(root))).toBe(realpathSync(source(root)));
        expect(realpathSync(link(root, "device-lab"))).toBe(realpathSync(source(root, "device-lab")));
        expectConsumer(root);
        const stat = lstatSync(link(root));
        buildWorkspacePackages(root);
        expect(lstatSync(link(root)).ino).toBe(stat.ino);
        expect(lstatSync(link(root)).mtimeMs).toBe(stat.mtimeMs);
        expectConsumer(root);
    });

    it("repairs dangling links pointing to an old checkout without bypassing NodeNext compilation", () => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(join(root, "old Windows checkout", "packages", "hyper-v"), link(root), linkType);
        buildWorkspacePackages(root);
        expectConsumer(root);
        if (process.platform !== "win32") expect(readlinkSync(link(root))).toBe(relative(scope(root), source(root)));
    });

    it("retargets a foreign link without deleting its target", () => {
        const root = fixture();
        const outside = join(root, "external workspace");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel"), "preserve outside bytes");
        mkdirSync(scope(root));
        symlinkSync(outside, link(root), linkType);
        buildWorkspacePackages(root);
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("preserve outside bytes");
        expectConsumer(root);
    });

    it("repairs a link whose old target traverses a regular file", () => {
        const root = fixture();
        const outside = join(root, "old checkout file");
        writeFileSync(outside, "preserve old target bytes");
        mkdirSync(scope(root));
        symlinkSync(join(outside, "packages", "hyper-v"), link(root), linkType);
        buildWorkspacePackages(root);
        expect(readFileSync(outside, "utf8")).toBe("preserve old target bytes");
        expectConsumer(root);
    });

    it.each(["relative", "absolute"])("leaves a correct %s link untouched", form => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(form === "relative" && process.platform !== "win32"
            ? relative(scope(root), source(root)) : source(root), link(root), linkType);
        const original = { target: readlinkSync(link(root)), stat: lstatSync(link(root)) };
        buildWorkspacePackages(root);
        expect(readlinkSync(link(root))).toBe(original.target);
        expect(lstatSync(link(root)).ino).toBe(original.stat.ino);
        expect(lstatSync(link(root)).mtimeMs).toBe(original.stat.mtimeMs);
        expectConsumer(root);
    });

    it.each(["file", "directory"])("preserves an ambiguous physical %s and prior output", kind => {
        const root = fixture();
        mkdirSync(scope(root));
        if (kind === "directory") mkdirSync(link(root));
        const preserved = kind === "directory" ? join(link(root), "sentinel") : link(root);
        writeFileSync(preserved, "physical object bytes");
        mkdirSync(join(source(root), "dist"));
        writeFileSync(join(source(root), "dist", "sentinel"), "old output");
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-not-linked");
        expect(readFileSync(preserved, "utf8")).toBe("physical object bytes");
        expect(readFileSync(join(source(root), "dist", "sentinel"), "utf8")).toBe("old output");
    });

    it("validates both entries before replacing the first broken link", () => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(join(root, "old checkout"), link(root), linkType);
        const target = readlinkSync(link(root));
        mkdirSync(link(root, "device-lab"));
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-not-linked");
        expect(readlinkSync(link(root))).toBe(target);
    });

    it.each(["scope", "node_modules"])("refuses a redirected %s without modifying its target", parent => {
        const root = fixture();
        const outside = join(root, "outside dependency parent");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel"), "outside");
        const entry = parent === "scope" ? scope(root) : join(root, "node_modules");
        if (parent === "node_modules") rmSync(entry, { recursive: true });
        symlinkSync(outside, entry, linkType);
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-parent-invalid");
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside");
        expect(readlinkSync(entry)).toBeTruthy();
    });

    it("rejects an invalid source manifest before any dependency or output mutation", () => {
        const root = fixture();
        writeFileSync(join(source(root, "device-lab"), "package.json"), '{"name":"foreign"}');
        mkdirSync(join(source(root), "dist"));
        const sentinel = join(source(root), "dist", "sentinel");
        writeFileSync(sentinel, "prior output");
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-source-invalid");
        expect(readFileSync(sentinel, "utf8")).toBe("prior output");
        expect(() => lstatSync(scope(root))).toThrow();
    });
});
