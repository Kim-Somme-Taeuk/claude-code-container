import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ handlers: [] as any[], result: {status:0,stdout:"",stderr:""} as any, calls: [] as any[] }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({Server:class { setRequestHandler(_schema:unknown, handler:any) {fixture.handlers.push(handler);} async connect(){} }}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({StdioServerTransport:class{}}));
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => ({
    ...await original<Record<string, unknown>>(),
    runWithTimeout: (...args:unknown[]) => {fixture.calls.push(args);return fixture.result;},
}));
import {startServer} from "../../device-lab-mcp/src/server.mjs";
import {TOOLS} from "../../device-lab-mcp/src/tools.mjs";
import {currentDisplayTarget} from "@ccc/device-lab/providers/display/x11.mjs";
beforeAll(async()=>{await startServer();});
beforeEach(()=>{fixture.calls.length=0;fixture.result={status:0,stdout:"",stderr:""};});
const call=(detail=false)=>fixture.handlers[1]({params:{name:"window_list",arguments:{deviceId:"x11-current-display",implicitBroker:false,detail}}});
describe("public desktop windows",()=>{
    it("retains the 59-tool surface and advertises implemented display capability",()=>{
        expect(TOOLS).toHaveLength(59);
        expect(currentDisplayTarget().capabilities).toContain("device_window_list");
    });
    it.each([false,true])("routes current display and preserves window output detail=%s",async detail=>{
        fixture.result.stdout=`42\t123\t${Buffer.from("Notes").toString("base64")}\n`;
        const result=await call(detail);
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0].text)).toMatchObject({windows:[{handle:"42",title:"Notes",processId:123}]});
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0][0]).toBe("bash");
    });
    it("returns real empty success, but flags query and decode failures",async()=>{
        expect(JSON.parse((await call()).content[0].text)).toMatchObject({windows:[]});
        fixture.result={status:1,stdout:"",stderr:"window-list-display-unavailable"};
        expect((await call()).isError).toBe(true);
        fixture.result={status:0,stdout:"bad",stderr:""};
        expect((await call()).isError).toBe(true);
    });
});
