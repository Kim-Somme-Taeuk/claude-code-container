import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

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

    it("advertises unique unprefixed names within the catalog byte budget", () => {
        expect(tools).toHaveLength(76);
        expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
        expect(tools.every(tool => !/^(device_|mobile_|display_)/.test(tool.name))).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThan(57211);
    });

    it("distinguishes owned targets, backend prerequisites, and single-backend inventory", () => {
        expect(description("list_devices")).toMatch(/owned|owner/);
        expect(description("backends")).toMatch(/prerequisite|availability|available/);
        expect(description("backends")).toMatch(/without starting|does not start|no.*start/);
        expect(description("inventory")).toMatch(/one backend|single.backend/);
        expect(description("inventory")).toContain("list_devices");
    });

    it("separates definition creation, startup, and physical attachment", () => {
        expect(description("create")).toMatch(/definition|define/);
        expect(description("create")).toContain("start");
        expect(description("start")).toMatch(/start|boot/);
        expect(description("attach")).toMatch(/physical/);
        expect(description("attach")).toMatch(/connect|attach/);
    });

    it("identifies creation platforms, mobile app IDs, permissions and battery controls", () => {
        const guidance = (name: string, field: string) => {
            const properties = tool(name).inputSchema.properties as Record<string, { description?: string }>;
            return (properties[field].description || "").toLowerCase();
        };
        expect(guidance("create", "image")).toMatch(/hyper-v.*macos.*ssh/);
        expect(guidance("create", "sourceImage")).toMatch(/hyper-v.*qemu/);
        expect(guidance("create", "sourceImage")).not.toMatch(/macos/);
        for (const platform of [/android/, /ios/, /hyper-v/, /macos/, /qemu/]) expect(description("create")).toMatch(platform);
        for (const name of ["launch_app", "uninstall_app", "stop_app", "wait_for_app"]) {
            expect(guidance(name, "packageName")).toContain("android");
            expect(guidance(name, "bundleId")).toContain("ios");
        }
        for (const name of ["grant_permission", "revoke_permission"]) {
            expect(guidance(name, "permission")).toContain("android");
            expect(guidance(name, "service")).toMatch(/ios.*simulator/);
        }
        for (const name of ["upload", "download"]) {
            expect(guidance(name, "localPath")).toMatch(/project.*host/);
            expect(guidance(name, "remotePath")).toMatch(/ios simulator.*relative.*bundleid/);
            expect(guidance(name, "containerType")).toMatch(/ios simulator.*default.*data/);
        }
        expect(guidance("install_app", "path")).toMatch(/package.*project.*host/);
        expect(guidance("launch_app", "component")).toMatch(/activity/);
        expect(guidance("key", "key")).toMatch(/android/);
        expect(guidance("key", "key")).toMatch(/ios/);
        expect(guidance("key", "keyCode")).toMatch(/android.*numeric|numeric.*android/);
        expect(guidance("set_battery", "level")).toMatch(/percent/);
        expect(guidance("set_battery", "charging")).toMatch(/charger|ac/);
        expect(guidance("set_battery", "status")).toMatch(/1.*unknown.*2.*charging.*3.*discharging.*4.*not charging.*5.*full/);
    });

    it.each(["image_list", "image_import", "target_list", "readiness_probe", "session_open", "workspace_sync", "artifacts_export", "guest_agent_status", "guest_agent_provision"])("%s identifies its container QEMU scope", name => {
        expect(description(name)).toMatch(/container.*qemu/);
    });

    it("distinguishes recorded target state, active readiness, and optional Appium diagnostics", () => {
        expect(description("target_list")).toMatch(/recorded|stored/);
        expect(description("readiness_probe")).toMatch(/probe|check/);
        expect(description("readiness_probe")).toMatch(/running|live|active/);
        expect(description("automation_status")).toMatch(/appium/);
        expect(description("automation_status")).toMatch(/optional|not required|not needed|do not require/);
    });

    it.each(["start", "reboot"])("%s explains waitForBoot polarity without claiming a universal default", (name) => {
        const properties = tool(name).inputSchema.properties as Record<string, { description?: string }>;
        const guidance = properties.waitForBoot.description!.toLowerCase();
        expect(guidance).toMatch(/false[^.;]*(skip|disable)|(?:skip|disable)[^.;]*false/);
        expect(guidance).toMatch(/linux-vm/);
        expect(guidance).toMatch(/windows-vm/);
        expect(guidance).toMatch(/reject|require|must/);
        expect(guidance).not.toMatch(/^skip the boot-readiness wait/);
        expect(guidance).not.toMatch(/defaults? to true[.;]|defaults? to false[.;]/);
    });

    it.each(["run_flow"])("%s explains static arguments, viewable images, and unmet waits", (name) => {
        const entry = tool(name);
        const guidance = JSON.stringify(entry).toLowerCase();
        expect(guidance).toMatch(/literal|fixed|static/);
        expect(guidance).toMatch(/no[^.;]*interpolat|not[^.;]*interpolat|without[^.;]*interpolat/);
        expect(guidance).toMatch(/screenshot[^.;]*viewable images/);
        expect(guidance).toMatch(/step references/);
        expect(guidance).toMatch(/wait[^.;]*(fail|unmet)|(fail|unmet)[^.;]*wait/);
        expect(description(name)).toMatch(/mobile/);
        if (name === "run_flow") expect(description(name)).toMatch(/display|desktop/);
    });

    it("describes the searched condition and non-match semantics of both waits", () => {
        expect(description("wait_for_text")).toMatch(/text/);
        expect(description("wait_for_text")).toMatch(/ui|hierarchy|source|substring/);
        expect(description("wait_for_app")).toMatch(/process|running/);
        expect(description("wait_for_app")).toMatch(/foreground|active/);
        for (const name of ["wait_for_text", "wait_for_app"]) {
            expect(description(name)).toMatch(/flow/);
            expect(description(name)).toMatch(/fail/);
        }
    });
});
