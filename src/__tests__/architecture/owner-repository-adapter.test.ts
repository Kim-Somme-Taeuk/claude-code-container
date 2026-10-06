import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileSymlinkOrSkip } from "../helpers/file-symlink-fixture.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const adapterUrl = new URL("../../../packages/device-lab/providers/adapters/state/owner-device-repository.mjs", import.meta.url).href;
const stateUrl = new URL("../../../packages/device-lab/providers/state/owner-device-state.mjs", import.meta.url).href;
let root: string;
let stateFile: string;
let mutationLockFile: string;

function isolatedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(CCC_|ANDROID_|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$)/i.test(key)) delete env[key];
    return { ...env, HOME: root, USERPROFILE: root, NODE_ENV: "test" };
}

function runNode(script: string, timeout = 15000) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: repository, env: isolatedEnv(), encoding: "utf8", timeout, windowsHide: true,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
}

function prelude() {
    return `
        import assert from 'node:assert/strict';
        import * as fs from 'node:fs';
        import { createFileOwnerDeviceRepository } from ${JSON.stringify(adapterUrl)};
        import { OwnerDeviceStateError, OWNER_DEVICE_STATE_FILE_LIMIT_BYTES } from ${JSON.stringify(stateUrl)};
        const stateFile = ${JSON.stringify(stateFile)};
        const mutationLockFile = ${JSON.stringify(mutationLockFile)};
        const repo = createFileOwnerDeviceRepository({stateFile, mutationLockFile});
        const stateError = code => error => error instanceof OwnerDeviceStateError && error.code === code;
    `;
}

describe("bound file owner-device repository", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-owner-repository-"));
        stateFile = join(root, ".ccc", "devices", "owners", "test-owner", "android", "devices.json");
        mutationLockFile = join(dirname(stateFile), "devices.mutation.lock");
    });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it("requires explicit paths and creates an absent empty file through no-op mutation", () => {
        runNode(prelude() + `
            for (const options of [{}, {stateFile}, {mutationLockFile}, {stateFile:1,mutationLockFile}, {stateFile,mutationLockFile:null}]) {
                assert.throws(() => createFileOwnerDeviceRepository(options), TypeError);
            }
            assert.deepEqual(repo.read(), []);
            assert.equal(repo.find('missing'), undefined);
            assert.equal(repo.update('missing', () => {throw Error('unexpected callback')}), null);
            assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), {devices:[]});
            assert.equal(fs.existsSync(mutationLockFile), false);
            const bytes = fs.readFileSync(stateFile, 'utf8');
            repo.mutate(devices => devices);
            assert.equal(fs.readFileSync(stateFile, 'utf8'), bytes);
        `);
    });
    it("preserves corrupt and oversized bytes and refuses all mutating recovery attempts", () => {
        runNode(prelude() + `
            fs.mkdirSync(${JSON.stringify(dirname(stateFile))}, {recursive:true});
            for (const [contents, code] of [
                ['{broken', 'owner-devices-state-invalid'],
                [JSON.stringify({devices:[{id:'..'}]}), 'owner-devices-state-invalid'],
                ['x'.repeat(OWNER_DEVICE_STATE_FILE_LIMIT_BYTES+1), 'owner-devices-file-too-large'],
            ]) {
                fs.writeFileSync(stateFile, contents);
                for (const operation of [() => repo.read(), () => repo.write([{id:'replacement'}]), () => repo.claim({id:'replacement'}), () => repo.mutate(() => {throw Error('unexpected updater')})]) {
                    assert.throws(operation, stateError(code));
                    assert.equal(fs.readFileSync(stateFile, 'utf8'), contents);
                    assert.equal(fs.existsSync(mutationLockFile), false);
                }
            }
        `);
    });
    it("uses writable byte bounds and exact successor comparison before atomic publication", () => {
        runNode(prelude() + `
            const successor = {id:'a', runtime:{generation:2}, metadata:'한글'};
            repo.write([successor]);
            const contents = fs.readFileSync(stateFile, 'utf8');
            assert.throws(() => repo.write([{id:'large',payload:'x'.repeat(OWNER_DEVICE_STATE_FILE_LIMIT_BYTES)}]), stateError('owner-devices-file-too-large'));
            assert.equal(fs.readFileSync(stateFile, 'utf8'), contents);
            assert.deepEqual(repo.transition('a', {...successor,runtime:{generation:1}}, null), {found:true,matched:false,currentDevice:successor,device:null});
            assert.equal(fs.readFileSync(stateFile, 'utf8'), contents);
            assert.equal(repo.transition('a', {metadata:'한글',runtime:{generation:2},id:'a'}, null).matched, true);
            assert.deepEqual(repo.read(), []);
            assert.equal(fs.existsSync(mutationLockFile), false);
        `);
    });
    it.for(["symbolic", "hard"] as const)("refuses %s linked state without touching the external target", (kind, context) => {
        const external = join(root, "external.json");
        const contents = JSON.stringify({ devices: [{ id: "external" }] });
        writeFileSync(external, contents);
        mkdirSync(dirname(stateFile), { recursive: true });
        if (kind === "symbolic") fileSymlinkOrSkip(context, external, stateFile);
        else linkSync(external, stateFile);
        runNode(prelude() + `
            for (const operation of [() => repo.read(), () => repo.write([{id:'replacement'}]), () => repo.mutate(() => [])]) {
                assert.throws(operation, stateError('owner-devices-state-invalid'));
                assert.equal(fs.existsSync(mutationLockFile), false);
            }
        `);
        expect(readFileSync(external, "utf8")).toBe(contents);
    });
    it.each(["owners", "owner", "backend"])("refuses a linked managed %s directory before publishing outside state", component => {
        const owners = join(root, ".ccc", "devices", "owners");
        const linked = component === "owners" ? owners : component === "owner" ? join(owners, "test-owner") : dirname(stateFile);
        const external = join(root, "external");
        mkdirSync(external);
        mkdirSync(dirname(linked), { recursive: true });
        symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
        runNode(prelude() + `
            assert.throws(() => repo.write([{id:'escaped'}]), error => error.code === 'device-lab-state-directory-invalid');
            assert.throws(() => repo.mutate(() => [{id:'escaped'}]), error => error.code === 'device-lab-state-directory-invalid');
        `);
        const suffix = component === "owners" ? ["test-owner", "android"] : component === "owner" ? ["android"] : [];
        expect(existsSync(join(external, ...suffix, "devices.json"))).toBe(false);
        expect(existsSync(join(external, ...suffix, "devices.mutation.lock"))).toBe(false);
    });
    it("serializes two Node processes under contention without losing updates", () => {
        const held = join(root, "held");
        const started = join(root, "started");
        const entered = join(root, "entered");
        const holder = prelude() + `
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            repo.mutate(devices => {
                fs.writeFileSync(${JSON.stringify(held)}, 'held');
                const deadline = Date.now()+5000;
                while (!fs.existsSync(${JSON.stringify(started)})) {
                    if (Date.now()>deadline) throw Error('waiter never started');
                    Atomics.wait(sleeper,0,0,10);
                }
                Atomics.wait(sleeper,0,0,150);
                assert.equal(fs.existsSync(${JSON.stringify(entered)}), false);
                return [...devices,{id:'holder',count:0}];
            });
            for(let i=0;i<15;i++) repo.update('holder', device => {
                Atomics.wait(sleeper,0,0,5);
                return {...device,count:device.count+1};
            });
        `;
        const waiter = prelude() + `
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            fs.writeFileSync(${JSON.stringify(started)}, 'started');
            repo.mutate(devices => {
                assert.equal(devices.some(device => device.id==='holder'),true);
                fs.writeFileSync(${JSON.stringify(entered)},'entered');
                return [...devices,{id:'waiter'}];
            });
            for(let i=0;i<15;i++) repo.update('holder', device => {
                Atomics.wait(sleeper,0,0,5);
                return {...device,count:device.count+1};
            });
        `;
        runNode(prelude() + `
            import {spawn} from 'node:child_process';
            const children=[];
            const launch = script => {
                const child=spawn(process.execPath,['--input-type=module','-e',script],{env:process.env,windowsHide:true});
                children.push(child);
                let stderr='';
                child.stderr.on('data',data=>stderr+=data);
                return new Promise((resolve,reject)=>{
                    child.on('error',reject);
                    child.on('exit',(code,signal)=>code===0?resolve():reject(Error(stderr+' exit='+code+' signal='+signal)));
                });
            };
            try {
                const first=launch(${JSON.stringify(holder)});
                const deadline=Date.now()+5000;
                while(!fs.existsSync(${JSON.stringify(held)})) {
                    if(Date.now()>deadline) throw Error('holder never acquired');
                    await new Promise(resolve=>setTimeout(resolve,10));
                }
                const second=launch(${JSON.stringify(waiter)});
                await Promise.all([first,second]);
                assert.deepEqual(repo.read(),[{id:'holder',count:30},{id:'waiter'}]);
                assert.equal(fs.existsSync(mutationLockFile),false);
            } finally {for(const child of children) if(child.exitCode===null) child.kill();}
        `, 20000);
    }, 25000);

    it.each(["packages/device-lab", "dist/packages/device-lab"])("routes %s facade and backend wrappers through the shipped Node resolver with refreshed owner context", packagePath => {
        const facade = new URL(`../../../${packagePath}/providers/state/device-store.mjs`, import.meta.url).href;
        const wrapper = new URL(`../../../${packagePath}/providers/state/android-state.mjs`, import.meta.url).href;
        runNode(`
            import assert from 'node:assert/strict';
            import {mkdirSync,readFileSync} from 'node:fs';
            import {join} from 'node:path';
            const store=await import(${JSON.stringify(facade)});
            const android=await import(${JSON.stringify(wrapper)});
            assert.throws(() => store.claimOwnerDevice(null, null), error => error instanceof TypeError && error.message === 'Owner device claim requires a device object');
            assert.throws(() => store.claimOwnerDevice(null, {id:'valid'}, []), error => error instanceof TypeError && error.message === 'Owner device claim requires at least one unique field');
            const home=${JSON.stringify(root)};
            const contexts=[
                {home,profile:'first',cwd:join(home,'project-a')},
                {home,profile:'second',cwd:join(home,'project-a')},
                {home:join(home,'other-home'),profile:'second',cwd:join(home,'project-b')},
            ];
            const paths=[];
            for(const [index,context] of contexts.entries()) {
                mkdirSync(context.cwd,{recursive:true});
                mkdirSync(context.home,{recursive:true});
                process.env.HOME=context.home; process.env.USERPROFILE=context.home;
                process.env.CCC_PROFILE=context.profile; process.chdir(context.cwd);
                const file=store.ownerStateFile('android'); paths.push(file);
                assert.ok(file.startsWith(join(context.home,'.ccc','devices','owners')));
                assert.deepEqual(android.readAndroidDevices(),[]);
                const device={id:'device-'+index,avdName:'avd-'+index,port:5554};
                assert.deepEqual(android.claimAndroidDevice(device),{ok:true,device});
                assert.equal(android.claimAndroidDevice({id:'other-'+index,port:5554}).field,'port');
                const updated={...device,status:'ready'};
                assert.deepEqual(android.updateAndroidDevice(device.id,()=>updated),updated);
                assert.deepEqual(android.findAndroidDevice(device.id),updated);
                assert.equal(android.transitionAndroidDevice(device.id,device,null).matched,false);
                assert.deepEqual(android.readAndroidDevices(),[updated]);
            }
            assert.equal(new Set(paths).size,3);
            for(const [index,file] of paths.entries()) assert.equal(JSON.parse(readFileSync(file,'utf8')).devices[0].id,'device-'+index);
        `);
    });
});
