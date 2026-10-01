import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freePort } from "./helpers/fake-broker-mcp-fixture.js";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { brokerAppium, withBrokerOperation } from "../../device-lab-mcp/src/broker.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";

// Real HTTP and Linux process identity; deliberately no NODE_ENV=test escape.
describe.skipIf(process.platform !== "linux")("broker composed observation budget with real generation attestation", () => {
    let home: string;
    let child: ChildProcess;
    let log: string;
    let behavior: string;
    let auth: string;
    let options: { hostCandidates: string[]; port: number; autolaunch: boolean; timeoutMs: number };
    const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const count = (path: string) => requests().filter(entry => entry === path).length;
    

    beforeEach(async () => {
        home = mkdtempSync(join(tmpdir(), "ccc-broker-flow-"));
        log = join(home, "requests.log");
        behavior = join(home, "behavior.json");
        auth = join(home, "auth.json");
        writeFileSync(log, "");
        writeFileSync(behavior, "{}");
        const owner = ownerId();
        writeFileSync(auth, JSON.stringify({ ownerId: owner, secret: "b".repeat(64) }), { mode: 0o600 });
        vi.stubEnv("HOME", home);
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("CCC_DEVICE_BROKER_AUTH_FILE", auth);
        vi.stubEnv("CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER", "");
        const port = await freePort();
        const script = join(home, "broker.cjs");
        writeFileSync(script, `
const fs=require('fs'),http=require('http'),crypto=require('crypto');
const log=${JSON.stringify(log)},behavior=${JSON.stringify(behavior)},owner=${JSON.stringify(owner)},port=${port};
const stat=fs.readFileSync('/proc/self/stat','utf8');
const token='linux:'+stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19];
const startedAt=new Date().toISOString();
const server=http.createServer((req,res)=>{
 fs.appendFileSync(log,req.url+'\\n');
 const state=JSON.parse(fs.readFileSync(behavior,'utf8'));
 const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 if(req.url==='/health')return send(200,{ok:true,name:'ccc-device-broker'});
 if(req.url==='/status')return setTimeout(()=>send(200,{ok:true,broker:{name:'ccc-device-broker',mode:'host-broker-daemon',port,process:{pid:process.pid,startToken:state.changedGeneration?'replacement-token':token},startedAt,protocolVersion:state.incompatible?0:${JSON.stringify(DEVICE_BROKER_PROTOCOL_VERSION)}}}),state.attestationDelay||0);
 if(req.url==='/v1/owner/resolve')return setTimeout(()=>send(200,{ok:true,result:{ownerId:owner}}),state.ownerDelay||0);
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  const h=req.headers,secret=JSON.parse(fs.readFileSync(${JSON.stringify(auth)},'utf8')).secret;
  const ownerToken=crypto.createHash('sha256').update('ccc-device-broker:owner:'+owner+':secret:'+secret).digest('hex');
  const payload=['v1',owner,h['x-ccc-device-auth-timestamp'],h['x-ccc-device-auth-nonce'],startedAt,token,crypto.createHash('sha256').update(body).digest('hex')].join('\\n');
  const expected=crypto.createHmac('sha256',ownerToken).update(payload).digest('hex');
  if(h['x-ccc-device-auth']!==expected)return send(401,{ok:false,error:'bad-generation-auth'});
  const rpc=JSON.parse(body);
  fs.appendFileSync(log,JSON.stringify(rpc)+'\\n');
  if(rpc.method==='broker.inventory')return send(200,{ok:true,result:{backends:[{stateKey:'android',devices:[{id:'pixel',backend:'android-emulator'}]}]}});
  if(rpc.method==='broker.appium.session.ensure')return send(200,{ok:true,result:{appium:{sessionId:'WAIT'}}});
  if(state.stallBody){res.writeHead(200,{'content-type':'application/json'});res.write('{"ok":true,"result":{"response":{"body":{"value":"matching text');return;}
  setTimeout(()=>send(200,{ok:true,result:{response:{body:{value:state.value||'<App>absent</App>'}}}}),state.rpcDelay||0);
 });
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({pid:process.pid,processStartToken:token,startedAt})+'\\n'));
`);
        child = spawn(process.execPath, [script, "devices", "broker", "serve", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
        const [data] = await once(child.stdout!, "data");
        const runtime = { ...JSON.parse(String(data)), name: "ccc-device-broker", ownerId: owner, managedBy: "ccc-host", host: "127.0.0.1", port, command: process.execPath, args: [script, "devices", "broker", "serve", "--port", String(port)] };
        const root = join(home, ".ccc", "devices", "broker");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "runtime.json"), JSON.stringify(runtime));
        options = { hostCandidates: ["127.0.0.1"], port, autolaunch: false, timeoutMs: 2000 };
    }, 15000);

    afterEach(async () => {
        if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
        vi.unstubAllEnvs();
        if (home) rmSync(home, { recursive: true, force: true });
    });

    it("subtracts delayed owner resolution and real attestation before forwarding the host allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 140 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 700 });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(count("/v1/owner/resolve")).toBe(1);
        expect(count("/status")).toBe(1);
        const sent = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(sent).toHaveLength(1);
        expect(sent[0].params.requestTimeoutMs).toBeGreaterThan(0);
        expect(sent[0].params.requestTimeoutMs).toBeLessThan(460);
    });

    it("leaves ordinary non-wait requests without an observation allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ rpcDelay: 180 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source" });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const sent = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(sent).toHaveLength(1);
        expect(sent[0].params).not.toHaveProperty("requestTimeoutMs");
    });

    it("does not restart the allowance for a stalled RPC after owner resolution and attestation", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 140, rpcDelay: 550 }));
        const started = performance.now();
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 600 });
        expect(result.ok, JSON.stringify(result)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(count("/status")).toBe(1);
        expect(requests().filter(line => line.startsWith("{"))).toHaveLength(1);
    });

    it("does not send an RPC when real attestation consumes the remaining allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 400 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 350 });
        expect(result.ok).toBe(false);
        expect(count("/status")).toBe(1);
        expect(requests().filter(line => line.startsWith("{"))).toHaveLength(0);
    });

    it.each([0, -1, NaN, Infinity, "100", null, 600001])("rejects invalid client observation allowance %s without transport", async (requestTimeoutMs) => {
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs });
        expect(result).toMatchObject({ ok: false, error: "invalid-appium-request-timeout" });
        expect(requests()).toEqual([]);
    });

    it.each([false, true])("public routed wait bootstraps once and preserves observation errors (stall=%s)", async (stallBody) => {
        writeFileSync(behavior, JSON.stringify({ stallBody }));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL("../../dist/device-lab-mcp/server.mjs", import.meta.url))],
            env: { ...process.env, HOME: home, NODE_ENV: "production", CCC_DEVICE_BROKER_AUTH_FILE: auth, CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "" } as Record<string, string>,
        });
        const client = new Client({ name: "broker-wait-contract", version: "1.0.0" });
        await client.connect(transport);
        try {
            const result = await client.callTool({ name: "wait_for_text", arguments: {
                ...options, viaBroker: true, deviceId: "pixel",
                text: "matching text", timeoutMs: 500, intervalMs: 300, detail: true,
            } });
            const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
            const rpcs = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
            expect(rpcs.filter(rpc => rpc.method === "broker.appium.session.ensure")).toHaveLength(1);
            const observations = rpcs.filter(rpc => rpc.method === "broker.appium.request");
            expect(observations.length).toBeGreaterThan(0);
            if (stallBody) {
                expect(payload.ok).toBe(false);
                expect(payload.found).toBeUndefined();
                expect(observations).toHaveLength(1);
            } else {
                expect(payload.found, JSON.stringify(payload)).toBe(false);
                expect(observations.length).toBeGreaterThan(1);
                for (let i = 1; i < observations.length; i++) {
                    expect(observations[i].params.requestTimeoutMs).toBeLessThan(observations[i - 1].params.requestTimeoutMs);
                }
            }
            expect(count("/health")).toBe(0);
            expect(count("/status")).toBe(rpcs.length);
            const requestsAtFinish = requests().length;
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(requests()).toHaveLength(requestsAtFinish);
        } finally { await client.close(); }
    }, 15000);
});
