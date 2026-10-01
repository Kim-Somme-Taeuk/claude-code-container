import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type McpClientHandle, createMcpClient, resolveChromiumPath } from "./helpers/mcp-stdio-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Integration tests for chrome-devtools MCP server.
// Gracefully skipped when Chromium is not available (e.g. pure unit test CI).
const TIMEOUT = 90000;

// Keep the MCP SDK's request budget aligned with the test budget.
const REQUEST_OPTIONS = { timeout: TIMEOUT };

const chromiumAvailable = (() => {
    try { resolveChromiumPath(); return true; } catch { return false; }
})();

describe.skipIf(!chromiumAvailable)("chrome-devtools MCP integration", () => {
    let handle: McpClientHandle;
    let client: Client;
    let pageId: number;

    beforeAll(async () => {
        handle = await createMcpClient();
        client = handle.client;
    }, TIMEOUT);

    afterAll(async () => {
        await handle?.cleanup();
    }, TIMEOUT);

    it("connects and returns server info", { timeout: TIMEOUT }, async () => {
        const serverVersion = client.getServerVersion();
        expect(serverVersion).toBeDefined();
        expect(serverVersion?.name).toBeTruthy();
    });

    it("lists tools including navigate_page and take_screenshot", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const toolNames = result.tools.map((t) => t.name);
        expect(toolNames).toContain("navigate_page");
        expect(toolNames).toContain("take_screenshot");
    });

    it("creates a new page", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "new_page",
            arguments: { url: "about:blank" },
        }, undefined, REQUEST_OPTIONS);
        expect(result.isError).not.toBe(true);
        expect(result.content).toBeDefined();
        const text = (result.content as Array<{ type: string; text?: string }>)[0].text || "";
        const selected = /^(\d+): .*\[selected\]/m.exec(text);
        expect(selected, text).not.toBeNull();
        pageId = Number(selected![1]);
    });

    // Use the page new_page selected. Hardcoding 1 targets the background startup tab;
    // its screenshot can stall even while navigation and script evaluation succeed.

    it("navigates to a data URI page", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "navigate_page",
            arguments: { pageId, url: "data:text/html,<h1>ccc-test</h1>", type: "url" },
        }, undefined, REQUEST_OPTIONS);
        expect(result.isError).not.toBe(true);
    });

    it("evaluates a script and returns the result", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "evaluate_script",
            arguments: { pageId, function: "() => ({ answer: 6 * 7, heading: document.querySelector('h1')?.textContent })" },
        }, undefined, REQUEST_OPTIONS);
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; text?: string }>;
        expect(content[0].text).toContain("42");
        expect(content[0].text).toContain("ccc-test");
    });

    it("takes a screenshot and returns an image", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({
            name: "take_screenshot",
            arguments: { pageId },
        }, undefined, REQUEST_OPTIONS);
        expect(result.isError).not.toBe(true);
        const content = result.content as Array<{ type: string; mimeType?: string }>;
        // content[0] is always text summary, content[1] is the image
        expect(content[1]).toBeDefined();
        expect(content[1].type).toBe("image");
    });
});
