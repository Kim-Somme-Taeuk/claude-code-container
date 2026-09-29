import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

// Baseline 9b1db42b: all 93 identities and schemas, recursively sorted with
// description fields removed. This pins constraints without copying the catalog
// or requiring Git history to be present when the tests run.
const BASELINE_SCHEMA_HASH = "d5f856ac4535e0b3723626e974c1ae7101caef7b08fa663f8e1d42c53465398c";
function withoutDescriptions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(object).filter((key) => key !== "description").sort()
            .map((key) => [key, withoutDescriptions(object[key])]));
    }
    return value;
}

describe("public Device Lab tool guidance", () => {
    let context: Awaited<ReturnType<typeof createDeviceLabMcpTestContext>>;
    let tools: Awaited<ReturnType<typeof context.client.listTools>>["tools"];
    const tool = (name: string) => {
        const found = tools.find((entry) => entry.name === name);
        expect(found, name).toBeDefined();
        return found!;
    };
    const description = (name: string) => tool(name).description!.toLowerCase();

    beforeAll(async () => {
        context = await createDeviceLabMcpTestContext();
        tools = (await context.client.listTools()).tools;
    }, TIMEOUT);
    afterAll(async () => { await cleanupDeviceLabMcpTestContext(context); });

    it("preserves tool identities and all non-description constraints within the original byte budget", () => {
        expect(tools).toHaveLength(93);
        expect(createHash("sha256").update(JSON.stringify(withoutDescriptions(tools))).digest("hex"))
            .toBe(BASELINE_SCHEMA_HASH);
        expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThanOrEqual(57496);
    });

    it("distinguishes owned targets, backend prerequisites, and single-backend inventory", () => {
        expect(description("device_list")).toMatch(/owned|owner/);
        expect(description("device_backends")).toMatch(/prerequisite|availability|available/);
        expect(description("device_backends")).toMatch(/without starting|does not start|no.*start/);
        expect(description("device_inventory")).toMatch(/one backend|single.backend/);
        expect(description("device_inventory")).toContain("device_list");
    });

    it("separates definition creation, startup, and physical attachment", () => {
        expect(description("device_create")).toMatch(/definition/);
        expect(description("device_create")).toContain("device_start");
        expect(description("device_start")).toMatch(/start|boot/);
        expect(description("device_attach")).toMatch(/physical/);
        expect(description("device_attach")).toMatch(/connect|attach/);
    });

    it("distinguishes recorded target state, active readiness, and optional Appium diagnostics", () => {
        expect(description("device_target_list")).toMatch(/recorded|stored/);
        expect(description("device_readiness_probe")).toMatch(/probe|check/);
        expect(description("device_readiness_probe")).toMatch(/running|live|active/);
        expect(description("mobile_session_status")).toMatch(/appium/);
        expect(description("mobile_session_status")).toMatch(/optional|not required|not needed|do not require/);
    });

    it.each(["device_start", "device_reboot"])("%s explains waitForBoot polarity without claiming a universal default", (name) => {
        const properties = tool(name).inputSchema.properties as Record<string, { description?: string }>;
        const guidance = properties.waitForBoot.description!.toLowerCase();
        expect(guidance).toMatch(/false[^.;]*(skip|disable)|(?:skip|disable)[^.;]*false/);
        expect(guidance).toMatch(/linux-vm/);
        expect(guidance).toMatch(/windows-vm/);
        expect(guidance).toMatch(/reject|require|must/);
        expect(guidance).not.toMatch(/^skip the boot-readiness wait/);
        expect(guidance).not.toMatch(/defaults? to true[.;]|defaults? to false[.;]/);
    });

    it.each(["mobile_run_flow", "device_run_flow"])("%s explains static arguments, image summaries, and unmet waits", (name) => {
        const entry = tool(name);
        const guidance = JSON.stringify(entry).toLowerCase();
        expect(guidance).toMatch(/literal|fixed|static/);
        expect(guidance).toMatch(/no[^.;]*interpolat|not[^.;]*interpolat|without[^.;]*interpolat/);
        expect(guidance).toMatch(/screenshot[^.;]*summar|summar[^.;]*screenshot/);
        expect(guidance).toMatch(/standalone|separately|directly/);
        expect(guidance).toMatch(/wait[^.;]*(fail|unmet)|(fail|unmet)[^.;]*wait/);
        expect(description(name)).toMatch(/mobile/);
        if (name === "device_run_flow") expect(description(name)).toMatch(/display|desktop/);
    });

    it("describes the searched condition and non-match semantics of both waits", () => {
        expect(description("mobile_wait_for_text")).toMatch(/text/);
        expect(description("mobile_wait_for_text")).toMatch(/ui|hierarchy|source|substring/);
        expect(description("mobile_wait_for_app")).toMatch(/process|running/);
        expect(description("mobile_wait_for_app")).toMatch(/foreground|active/);
        for (const name of ["mobile_wait_for_text", "mobile_wait_for_app"]) {
            expect(description(name)).toMatch(/flow/);
            expect(description(name)).toMatch(/fail/);
        }
    });
});
