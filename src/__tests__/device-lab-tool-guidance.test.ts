import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

// Derived from 06594d27 TOOLS (not the current implementation): remove only
// backend property/requirement on the eleven single-backend tools and create.options.
// Descriptions and canonical flow are excluded as in the prior guidance baseline.
const BASELINE_SCHEMA_HASH = "9b95c8035de17364eb000eb6abfcfe98e5943eeb2acfe1923aa18e601454f232";
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

    it("preserves unchanged schemas and reduces the advertised catalog byte budget", () => {
        expect(tools).toHaveLength(87);
        expect(createHash("sha256").update(JSON.stringify(withoutDescriptions(tools.filter((tool) => tool.name !== "device_run_flow")))).digest("hex"))
            .toBe(BASELINE_SCHEMA_HASH);
        expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThan(57211);
    });

    it("distinguishes owned targets, backend prerequisites, and single-backend inventory", () => {
        expect(description("device_list")).toMatch(/owned|owner/);
        expect(description("device_backends")).toMatch(/prerequisite|availability|available/);
        expect(description("device_backends")).toMatch(/without starting|does not start|no.*start/);
        expect(description("device_inventory")).toMatch(/one backend|single.backend/);
        expect(description("device_inventory")).toContain("device_list");
    });

    it("separates definition creation, startup, and physical attachment", () => {
        expect(description("device_create")).toMatch(/definition|define/);
        expect(description("device_create")).toContain("device_start");
        expect(description("device_start")).toMatch(/start|boot/);
        expect(description("device_attach")).toMatch(/physical/);
        expect(description("device_attach")).toMatch(/connect|attach/);
    });

    it("identifies creation platforms, mobile app IDs, permissions and battery controls", () => {
        const guidance = (name: string, field: string) => {
            const properties = tool(name).inputSchema.properties as Record<string, { description?: string }>;
            return (properties[field].description || "").toLowerCase();
        };
        expect(guidance("device_create", "image")).toMatch(/hyper-v.*macos.*ssh/);
        expect(guidance("device_create", "sourceImage")).toMatch(/hyper-v.*qemu/);
        expect(guidance("device_create", "sourceImage")).not.toMatch(/macos/);
        for (const platform of [/android/, /ios/, /hyper-v/, /macos/, /qemu/]) expect(description("device_create")).toMatch(platform);
        for (const name of ["device_launch_app", "mobile_uninstall_app", "mobile_stop_app", "mobile_wait_for_app"]) {
            expect(guidance(name, "packageName")).toContain("android");
            expect(guidance(name, "bundleId")).toContain("ios");
        }
        for (const name of ["mobile_grant_permission", "mobile_revoke_permission"]) {
            expect(guidance(name, "permission")).toContain("android");
            expect(guidance(name, "service")).toMatch(/ios.*simulator/);
        }
        for (const name of ["device_upload", "device_download"]) {
            expect(guidance(name, "localPath")).toMatch(/project.*host/);
            expect(guidance(name, "remotePath")).toMatch(/ios simulator.*relative.*bundleid/);
            expect(guidance(name, "containerType")).toMatch(/ios simulator.*default.*data/);
        }
        expect(guidance("device_install_app", "path")).toMatch(/package.*project.*host/);
        expect(guidance("device_launch_app", "component")).toMatch(/activity/);
        expect(guidance("mobile_key", "key")).toMatch(/android/);
        expect(guidance("mobile_key", "key")).toMatch(/ios/);
        expect(guidance("mobile_key", "keyCode")).toMatch(/android.*numeric|numeric.*android/);
        expect(guidance("mobile_set_battery", "level")).toMatch(/percent/);
        expect(guidance("mobile_set_battery", "charging")).toMatch(/charger|ac/);
        expect(guidance("mobile_set_battery", "status")).toMatch(/1.*unknown.*2.*charging.*3.*discharging.*4.*not charging.*5.*full/);
    });

    it.each(["device_image_list", "device_image_import", "device_target_list", "device_readiness_probe", "device_session_open", "device_workspace_sync", "device_artifacts_export", "device_guest_agent_status", "device_guest_agent_provision"])("%s identifies its container QEMU scope", name => {
        expect(description(name)).toMatch(/container.*qemu/);
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

    it.each(["device_run_flow"])("%s explains static arguments, viewable images, and unmet waits", (name) => {
        const entry = tool(name);
        const guidance = JSON.stringify(entry).toLowerCase();
        expect(guidance).toMatch(/literal|fixed|static/);
        expect(guidance).toMatch(/no[^.;]*interpolat|not[^.;]*interpolat|without[^.;]*interpolat/);
        expect(guidance).toMatch(/screenshot[^.;]*viewable images/);
        expect(guidance).toMatch(/step references/);
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
