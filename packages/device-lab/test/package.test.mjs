import {test, after} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {fileURLToPath, pathToFileURL} from "node:url";
import {tmpdir} from "node:os";
import {join} from "node:path";
const temporary = mkdtempSync(join(tmpdir(), "device-lab-package-test-"));
process.env.HOME = temporary;
process.env.USERPROFILE = temporary;
const {deviceLabOwnerId} = await import("../dist/device-lab-owner.js");
const {ownerId, PACKAGE_ROOT} = await import("../providers/context.mjs");
const {createDeviceBrokerServer, ensureHostDeviceBroker} = await import("../dist/device-lab-broker.js");
const {hyperVPowerShellAssetPath} = await import("../dist/host-control/hyper-v/powershell-assets.js");
after(() => rmSync(temporary, {recursive:true,force:true}));

test("core and providers agree on owner identity", () => {
    for (const project of ["/project/example-0123456789ab", "/tmp/workspace"])
        assert.equal(deviceLabOwnerId(project), ownerId({}, project));
    assert.ok(readFileSync(new URL("../package.json", import.meta.url), "utf8").includes('"@ccc/device-lab"'));
    assert.ok(readFileSync(`${PACKAGE_ROOT}/appium-runtime/package-lock.json`, "utf8").includes('"appium"'));
});

test("package-owned PowerShell assets retain integrity verification", () => {
    for (const operation of ["guest-boot-diagnostic", "linux-bootstrap-network", "snapshot-repair", "windows-operation"])
        assert.ok(readFileSync(hyperVPowerShellAssetPath(operation), "utf8").length > 0);
});

test("standalone core serves health without CCC or MCP", async () => {
    const server = createDeviceBrokerServer({cwd: "/tmp/package-smoke"});
    try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.name, "ccc-device-broker");
        assert.equal(body.ok, true);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test("standalone and explicitly trusted legacy launchers reuse the same verified process", {timeout:60000}, async () => {
    writeFileSync(join(temporary, "package.json"), '{"type":"module"}');
    const legacy = join(temporary, "index.js");
    writeFileSync(legacy, `import {startDeviceBrokerServe} from ${JSON.stringify(new URL("../dist/device-lab-broker.js", import.meta.url).href)};startDeviceBrokerServe(process.argv.slice(5));`);
    for (const entry of [fileURLToPath(new URL("../dist/broker-entry.js", import.meta.url)), legacy]) {
        const reservation = createServer();
        await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const child = spawn(process.execPath, [entry, "devices", "broker", "serve", "--host", "127.0.0.1", "--port", String(port)], {
            cwd: temporary, stdio:"ignore", windowsHide:true,
        });
        const closed = new Promise(resolve => child.once("close", resolve));
        try {
            let ready = false;
            for (let attempt=0; attempt<100 && child.exitCode===null; attempt++) {
                try {ready = (await fetch(`http://127.0.0.1:${port}/health`, {signal:AbortSignal.timeout(200)})).ok;} catch {}
                if (ready) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(ready, `launcher did not start: ${pathToFileURL(entry).href}`);
            const result = await ensureHostDeviceBroker({cwd:temporary, port, probeHost:"127.0.0.1",
                ...(entry===legacy ? {trustedCliPaths:[legacy]} : {}), timeoutMs:300, startupTimeoutMs:1000});
            assert.equal(result.ok, true, result.error);
            assert.equal(result.reused, true);
            assert.equal(result.verifiedBrokerPid, child.pid);
        } finally {
            child.kill();
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
            try {await closed;} finally {clearTimeout(timer);}
        }
    }
});
