import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { validateOwnerDevicePayload } from "../../../packages/device-lab/providers/domain/owner-device-payload.mjs";

const pattern = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
const repository = fileURLToPath(new URL("../../../", import.meta.url));

describe("canonical owner-state payload", () => {
    it("keeps the packaged declaration identical to the checked implementation", () => {
        const source = join(repository, "packages/device-lab/providers/domain/owner-device-payload.mjs");
        const program = ts.createProgram([source], {
            allowJs: true, checkJs: true, strict: true, declaration: true, emitDeclarationOnly: true,
            skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext, outDir: join(repository, "unused-declaration-output"),
        });
        expect(program.getSourceFile(source)).toBeDefined();
        expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
        let declaration = "";
        const emitted = program.emit(undefined, (path, text) => {
            if (path.endsWith("owner-device-payload.d.mts")) declaration = text;
        });
        expect(emitted.emitSkipped).toBe(false);
        expect(declaration).not.toBe("");
        const normalize = (text: string) => ts.createPrinter({ removeComments: true }).printFile(
            ts.createSourceFile("contract.d.mts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
        ).replace(/'/g, '"');
        expect(normalize(declaration)).toBe(normalize(readFileSync(source.replace(/\.mjs$/, ".d.mts"), "utf8")));
    });
    it.each([null, [], {}, { devices: null }, { devices: {} }, { devices: [null] }, { devices: [[]] }])("rejects malformed payload %j", parsed => {
        expect(validateOwnerDevicePayload(parsed, pattern)).toEqual({ kind: "invalid" });
    });
    it.each(["", ".", "..", "a/b", "a\\b", "C:disk", "한글", "a".repeat(129), null, 1])("rejects unsafe ID %j", id => {
        expect(validateOwnerDevicePayload({ devices: [{ id }] }, pattern)).toEqual({ kind: "invalid" });
    });
    it.each(["", null, 1, "a".repeat(129)])("rejects invalid AVD name %j", avdName => {
        expect(validateOwnerDevicePayload({ devices: [{ id: "safe", avdName }] }, pattern)).toEqual({ kind: "invalid" });
    });
    it("rejects duplicate IDs and AVD names independently", () => {
        for (const devices of [[{ id: "a" }, { id: "a" }], [{ id: "a", avdName: "avd" }, { id: "b", avdName: "avd" }]]) {
            expect(validateOwnerDevicePayload({ devices }, pattern)).toEqual({ kind: "invalid" });
        }
    });
    it("preserves original array, records and extra fields at exact character limits", () => {
        const devices = [{ id: "a".repeat(128), avdName: "b".repeat(128), metadata: { text: "한글" } }];
        const result = validateOwnerDevicePayload({ devices, extra: true }, pattern);
        expect(result.kind).toBe("valid");
        if (result.kind !== "valid") throw new Error("unexpected invalid outcome");
        expect(result.devices).toBe(devices);
        expect(result.devices[0]).toBe(devices[0]);
        expect(validateOwnerDevicePayload({ devices: [] }, pattern)).toEqual({ kind: "valid", devices: [] });
    });
    it("preserves both shipped adapters' class identity, byte limits and read failures", () => {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import assert from 'node:assert/strict';
            import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
            import {tmpdir} from 'node:os';
            import {join} from 'node:path';
            const root = mkdtempSync(join(tmpdir(), 'ccc-owner-payload-'));
            try {
                for (const path of [
                    './packages/device-lab/providers/state/owner-device-state.mjs',
                    './dist/packages/device-lab/providers/state/owner-device-state.mjs',
                    './packages/device-lab/dist/device-lab-owner-state.js',
                    './dist/packages/device-lab/dist/device-lab-owner-state.js',
                ]) {
                    const m = await import(path);
                    const devices = [{id:'valid', metadata:'한글'}];
                    const serialized = JSON.stringify({devices}, null, 2);
                    const bytes = Buffer.byteLength(serialized);
                    m.assertOwnerDeviceStateWritable(devices, bytes);
                    const matches = code => error => error instanceof m.OwnerDeviceStateError && error.code === code;
                    assert.throws(() => m.assertOwnerDeviceStateWritable(devices, bytes-1), matches('owner-devices-file-too-large'));
                    for (const invalid of [[{id:'..'}], [{id:'x'}, {id:'x'}], [{id:'x',avdName:''}]]) {
                        assert.throws(() => m.assertOwnerDeviceStateWritable(invalid), matches('owner-devices-state-invalid'));
                    }
                    const file = join(root, 'devices.json');
                    writeFileSync(file, serialized);
                    assert.deepEqual(m.readOwnerDeviceStateFile(file, bytes), devices);
                    assert.throws(() => m.readOwnerDeviceStateFile(file, bytes-1), matches('owner-devices-file-too-large'));
                    writeFileSync(file, '{broken');
                    assert.throws(() => m.readOwnerDeviceStateFile(file), error => matches('owner-devices-state-invalid')(error) && error.cause instanceof SyntaxError);
                    assert.equal(readFileSync(file, 'utf8'), '{broken');
                    assert.deepEqual(m.readOwnerDeviceStateFile(join(root, 'absent.json')), []);
                }
            } finally { rmSync(root, {recursive:true, force:true}); }
        `], { cwd: repository, encoding: "utf8", timeout: 15000, windowsHide: true });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
    });
});
