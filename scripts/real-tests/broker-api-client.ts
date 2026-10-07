import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// A persistent isolated process preserves broker child ownership between calls.
// This is an internal API fixture, not an alternate public MCP entry point.
export function createBrokerApiClient(env: NodeJS.ProcessEnv, moduleUrl = new URL("../../device-lab-mcp/src/broker.mjs", import.meta.url).href) {
    const program = `import * as broker from ${JSON.stringify(moduleUrl)};
import { createInterface } from 'node:readline';
const allowed = ['brokerStatus', 'brokerRpc', 'brokerLease', 'brokerPhysical', 'brokerApple', 'brokerCommand', 'brokerAppium', 'brokerShutdown'];
for await (const line of createInterface({input:process.stdin})) {
 const {operation,args} = JSON.parse(line);
 try {
  if (!allowed.includes(operation)) throw new Error('Unknown internal broker operation');
  const value = await broker.withBrokerOperation(() => broker[operation](args));
  process.stdout.write(JSON.stringify({content:[{type:'text',text:JSON.stringify(value)}],isError:value?.ok===false})+'\\n');
 } catch(error) { process.stdout.write(JSON.stringify({error:error.message})+'\\n'); }
}
process.exit(0);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = [];
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-65536); });
    createInterface({ input: child.stdout }).on("line", line => {
        const waiter = pending.shift();
        if (!waiter) return;
        try {
            const value = JSON.parse(line);
            if (value.error) waiter.reject(new Error(value.error)); else waiter.resolve(value);
        } catch (error) { waiter.reject(error as Error); }
    });
    const fail = (error: Error) => { for (const waiter of pending.splice(0)) waiter.reject(error); };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", code => fail(new Error(stderr || `Internal broker API exited ${code}`)));
    return {
        call(operation: string, args: Record<string, unknown> = {}) {
            return new Promise<any>((resolve, reject) => {
                if (child.exitCode !== null || child.stdin.writableEnded) {
                    reject(new Error("Internal broker API is closed"));
                    return;
                }
                pending.push({ resolve, reject });
                child.stdin.write(JSON.stringify({ operation, args }) + "\n");
            });
        },
        async close() {
            if (child.exitCode !== null) return;
            child.stdin.end();
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
                child.once("close", () => { clearTimeout(timer); resolve(); });
            });
        },
    };
}
