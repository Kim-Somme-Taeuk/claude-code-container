import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOwnedImportRead } from "./owned-import-read.mjs";

test("owned import phase admits code and exact manifest, then closes", async t => {
    const root = fs.mkdtempSync(join(tmpdir(), "ccc-import-read-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = join(root, "package.json");
    const source = join(root, "source.js");
    const other = join(root, "other.mjs");
    for (const path of [manifest, source, other]) fs.writeFileSync(path, "owned");
    const guard = await createOwnedImportRead(pathToFileURL(root + "/"), pathToFileURL(manifest), "test");
    assert.equal(guard.read(source, "utf8"), "owned");
    assert.equal(guard.manifestReads, 0);
    assert.deepEqual(guard.read(pathToFileURL(source)), Buffer.from("owned"));
    guard.restrictSources([pathToFileURL(source)]);
    assert.throws(() => guard.read(other), /unowned import-time read/);
    assert.equal(guard.read(pathToFileURL(manifest), { encoding: "utf8" }), "owned");
    assert.equal(guard.manifestReads, 1);
    guard.restrictSources(null);
    assert.equal(guard.read(other, "utf8"), "owned");
    guard.close();
    assert.throws(() => guard.read(source), /unowned import-time read/);
});

test("denials happen before captured read and permitted read errors retain identity", async t => {
    const root = fs.mkdtempSync(join(tmpdir(), "ccc-import-deny-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = join(root, "package.json");
    const source = join(root, "source.js");
    const data = join(root, "data.json");
    for (const path of [manifest, source, data]) fs.writeFileSync(path, "owned");
    fs.mkdirSync(join(root, "directory.js"));
    let calls = 0;
    let received;
    const failure = new Error("original read failure");
    const read = fs.readFileSync;
    fs.readFileSync = (...args) => { calls++; received = args; throw failure; };
    let guard;
    try { guard = await createOwnedImportRead(pathToFileURL(root), pathToFileURL(manifest), "test"); }
    finally { fs.readFileSync = read; }
    for (const selected of [0, {}, Buffer.from(source), "source.js", new URL("https://example.com/source.js"),
        new URL(`${pathToFileURL(source)}?alias`), new URL(`${pathToFileURL(source)}#alias`),
        join(root + "-sibling", "source.js"), join(root, "..", "outside.js"), data, join(root, "directory.js")]) {
        assert.throws(() => guard.read(selected), /unowned import-time read/);
        assert.equal(calls, 0);
    }
    const selected = pathToFileURL(source);
    const options = { encoding: "utf8" };
    assert.throws(() => guard.read(selected, options), error => error === failure);
    assert.equal(received[0], selected);
    assert.equal(received[1], options);
    assert.equal(calls, 1);
    assert.throws(() => guard.read(join(root, "absent.js")), { code: "ENOENT" });
    assert.equal(calls, 1);
});

test("final and ancestor links cannot expose unowned sources", async t => {
    const parent = fs.mkdtempSync(join(tmpdir(), "ccc-import-links-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, "owned");
    const outside = join(parent, "outside");
    fs.mkdirSync(root); fs.mkdirSync(outside);
    const target = join(outside, "source.js");
    fs.writeFileSync(target, "outside");
    const guard = await createOwnedImportRead(pathToFileURL(root), pathToFileURL(join(root, "package.json")), "test");
    const hard = join(root, "hard.js");
    fs.linkSync(target, hard);
    assert.throws(() => guard.read(hard), /unowned import-time read/);
    try { fs.symlinkSync(target, join(root, "symbolic.js")); }
    catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
            t.diagnostic("file symlink case unavailable without Windows privilege; hardlink proof passed");
        } else throw error;
    }
    if (fs.existsSync(join(root, "symbolic.js"))) assert.throws(() => guard.read(join(root, "symbolic.js")), /unowned import-time read/);
    fs.symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => guard.read(join(root, "linked", "source.js")), /unowned import-time read/);
});
