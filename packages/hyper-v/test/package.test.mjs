import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("published files resolve independently and reject a modified operation asset", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-"));
    try {
        const installedRoot = join(temporaryRoot, "node_modules", "@ccc", "hyper-v");
        for (const name of ["package.json", "dist", "powershell"]) {
            cpSync(join(packageRoot, name), join(installedRoot, name), { recursive: true });
        }
        const consumer = join(temporaryRoot, "consumer.mjs");
        writeFileSync(consumer, `
            import assert from "node:assert/strict";
            import { verifiedOperationAsset, createHyperVWindowsClient } from "@ccc/hyper-v";
            import { verifiedOperationAsset as lowLevelAsset } from "@ccc/hyper-v/low-level/index.js";
            import * as lifecycle from "@ccc/hyper-v/lifecycle/index.js";
            import * as retry from "@ccc/hyper-v/lifecycle/retry.js";
            assert.equal(typeof createHyperVWindowsClient, "function");
            assert.equal(verifiedOperationAsset, lowLevelAsset);
            assert.ok(Object.keys(lifecycle).length > 0);
            assert.ok(Object.keys(retry).length > 0);
            const asset = verifiedOperationAsset();
            assert.ok(asset.scriptSource.length > 1000);
            assert.ok(asset.scriptPath.startsWith(${JSON.stringify(installedRoot)}));
            console.log("verified packaged operation");
        `);
        const result = spawnSync(process.execPath, [consumer], { cwd: temporaryRoot, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /verified packaged operation/);

        const assetPath = join(installedRoot, "powershell", "Invoke-HyperVWindowsOperation.ps1");
        writeFileSync(assetPath, `${readFileSync(assetPath, "utf8")}\n# modified\n`);
        const tampered = spawnSync(process.execPath, [consumer], { cwd: temporaryRoot, encoding: "utf8" });
        assert.notEqual(tampered.status, 0);
        assert.match(tampered.stderr, /hyper-v-windows-powershell-asset-integrity-failed/);
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
