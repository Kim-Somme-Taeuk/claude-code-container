import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {TOOLS} from "../src/tools.mjs";
import {brokerLaunchInvocation} from "../src/broker.mjs";
import {startServer} from "../src/server.mjs";

test("adapter resolves its declared core and SDK dependencies", () => {
    assert.equal(typeof startServer, "function");
    for (const platform of ["linux", "darwin", "win32"]) {
        const launcher = brokerLaunchInvocation("127.0.0.1", 17373, {platform});
        assert.equal(launcher.command, process.execPath);
        assert.ok(existsSync(launcher.args[0]));
        assert.deepEqual(launcher.args.slice(1, 4), ["devices", "broker", "serve"]);
    }
});

test("public interaction catalog remains platform independent", () => {
    for (const name of ["screenshot", "click", "move", "type", "list_files"]) {
        const tool = TOOLS.find(tool => tool.name === name);
        assert.ok(tool, name);
        assert.ok(tool.inputSchema.required.includes("deviceId"), name);
        assert.equal(tool.inputSchema.properties.backend, undefined, name);
    }
});
