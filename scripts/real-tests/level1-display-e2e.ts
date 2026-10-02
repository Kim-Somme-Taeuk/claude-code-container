import assert from "assert";
import { commandPath } from "./helpers.ts";
import { parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { aggregateStepResult } from "./result-status.ts";

export const name = "level 1 current display MCP E2E";
const scriptedArgumentFacets = [
    "click:button=left",
    "click:button=right",
    "click:count=2",
    "scroll:direction=down",
    "scroll:direction=left",
    "scroll:direction=right",
    "scroll:direction=up",
    "click:button=left",
    "click:button=right",
    "click:count=2",
    "scroll:direction=down",
    "scroll:direction=left",
    "scroll:direction=right",
    "scroll:direction=up",
];

function imageData(contentItem) {
    assert.strictEqual(contentItem?.type, "image");
    assert.strictEqual(contentItem.mimeType, "image/png");
    const data = String(contentItem.data || "");
    assert.ok(data.startsWith("iVBORw0KGgo"), "screenshot is not a PNG image payload");
    assert.ok(data.length > 64, "screenshot image payload is unexpectedly small");
    return data;
}

function cursorPoint(result) {
    const payload = parseToolPayload(result);
    assert.strictEqual(typeof payload.x, "number", JSON.stringify(payload));
    assert.strictEqual(typeof payload.y, "number", JSON.stringify(payload));
    return { x: payload.x, y: payload.y };
}

async function assertCursorAt(callTool, expected, label) {
    const cursor = await callTool("cursor_position", { detail: true, deviceId: "x11-current-display" });
    assert.notStrictEqual(cursor?.isError, true, `${label}: ${cursor?.content?.[0]?.text || ""}`);
    assert.deepStrictEqual(cursorPoint(cursor), expected, label);
}

export function currentDisplayPrerequisiteResult(missing) {
    const steps = [{ name: "current display prerequisites", status: "SKIP", reason: `missing ${missing.join(", ")}` }];
    return { ...aggregateStepResult(steps), steps };
}

export async function run() {
    const missing = ["xdotool", "scrot"].filter((command) => !commandPath(command));
    if (missing.length > 0) return currentDisplayPrerequisiteResult(missing);

    const steps = [];
    await withDeviceLabMcp(async ({ callTool }) => {
        const current = parseToolPayload(await callTool("status", { detail: true, deviceId: "x11-current-display" }));
        if (current.available !== true) {
            steps.push({ name: "current display available", status: "SKIP", reason: `display target is unavailable: ${current.display || "<unset>"}` });
            return;
        }
        steps.push({ name: "current display available", status: "PASS", detail: `display=${current.display}` });

        const listed = parseToolPayload(await callTool("devices", { detail: true }));
        assert.ok(Array.isArray(listed.devices), JSON.stringify(listed));
        assert.ok(listed.devices.some((device) => device.deviceId === "x11-current-display" && device.available === true), JSON.stringify(listed.devices));
        steps.push({ name: "devices includes current display", status: "PASS" });

        const displayDevice = { deviceId: "x11-current-display" };
        const status = parseToolPayload(await callTool("status", { detail: true, deviceId: displayDevice.deviceId }));
        assert.strictEqual(status.deviceId, "x11-current-display", JSON.stringify(status));
        assert.strictEqual(status.kind, "display", JSON.stringify(status));
        assert.strictEqual(status.available, true, JSON.stringify(status));
        steps.push({ name: "device_status current display alias", status: "PASS" });

        const cursor = await callTool("cursor_position", { detail: true, deviceId: "x11-current-display" });
        if (cursor?.isError === true) {
            steps.push({ name: "display command execution", status: "SKIP", reason: cursor.content?.[0]?.text || "display command failed" });
            return;
        }
        cursorPoint(cursor);
        steps.push({ name: "cursor position", status: "PASS" });

        const moved = await callTool("move", { detail: true, deviceId: "x11-current-display", x: 1, y: 1 });
        assert.notStrictEqual(moved?.isError, true, JSON.stringify(moved));
        await assertCursorAt(callTool, { x: 1, y: 1 }, "move cursor");
        steps.push({ name: "move current display cursor", status: "PASS" });

        const screenshot = await callTool("screenshot", { detail: true, deviceId: "x11-current-display" });
        imageData(screenshot?.content?.[0]);
        steps.push({ name: "display screenshot", status: "PASS" });

        const deviceScreenshot = await callTool("screenshot", { detail: true, deviceId: displayDevice.deviceId });
        imageData(deviceScreenshot?.content?.[0]);
        steps.push({ name: "device_screenshot current display alias", status: "PASS" });

        for (const button of ["left", "right"]) {
            const click = await callTool("click", { detail: true, deviceId: "x11-current-display", x: 1, y: 1, button });
            assert.notStrictEqual(click?.isError, true, `display_click ${button}: ${click?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(click).clicked, { x: 1, y: 1, button });
            await assertCursorAt(callTool, { x: 1, y: 1 }, `display_click ${button} cursor`);
        }
        steps.push({ name: "display_click buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const deviceClick = await callTool("click", { detail: true, deviceId: displayDevice.deviceId, x: 1, y: 1, button });
            assert.notStrictEqual(deviceClick?.isError, true, `device_click ${button}: ${deviceClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceClick).clicked, { x: 1, y: 1, button });
            await assertCursorAt(callTool, { x: 1, y: 1 }, `device_click ${button} cursor`);
        }
        steps.push({ name: "device_click current display alias buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const doubleClick = await callTool("click", { count: 2, detail: true, deviceId: "x11-current-display", x: 1, y: 1, button });
            assert.notStrictEqual(doubleClick?.isError, true, `display_double_click ${button}: ${doubleClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(doubleClick).doubleClicked, { x: 1, y: 1, button });
        }
        steps.push({ name: "display_double_click buttons", status: "PASS" });

        for (const button of ["left", "right"]) {
            const deviceDoubleClick = await callTool("click", { count: 2, detail: true, deviceId: displayDevice.deviceId, x: 1, y: 1, button });
            assert.notStrictEqual(deviceDoubleClick?.isError, true, `device_double_click ${button}: ${deviceDoubleClick?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceDoubleClick).doubleClicked, { x: 1, y: 1, button });
        }
        steps.push({ name: "device_double_click current display alias buttons", status: "PASS" });

        const key = await callTool("key", { detail: true, deviceId: "x11-current-display", key: "Escape" });
        assert.notStrictEqual(key?.isError, true, `display_key: ${key?.content?.[0]?.text || ""}`);
        assert.strictEqual(parseToolPayload(key).key, "Escape");
        steps.push({ name: "key", status: "PASS" });

        const deviceKey = await callTool("key", { detail: true, deviceId: displayDevice.deviceId, key: "Escape" });
        assert.notStrictEqual(deviceKey?.isError, true, `device_key: ${deviceKey?.content?.[0]?.text || ""}`);
        assert.strictEqual(parseToolPayload(deviceKey).key, "Escape");
        steps.push({ name: "device_key current display alias", status: "PASS" });

        const type = await callTool("type", { detail: true, deviceId: "x11-current-display", text: "ccc-display-e2e" });
        assert.notStrictEqual(type?.isError, true, `display_type: ${type?.content?.[0]?.text || ""}`);
        assert.deepStrictEqual({ typed: parseToolPayload(type).typed, length: parseToolPayload(type).length }, { typed: true, length: "ccc-display-e2e".length });
        steps.push({ name: "type", status: "PASS" });

        const deviceType = await callTool("type", { detail: true, deviceId: displayDevice.deviceId, text: "ccc-display-e2e" });
        assert.notStrictEqual(deviceType?.isError, true, `device_type: ${deviceType?.content?.[0]?.text || ""}`);
        assert.deepStrictEqual({ typed: parseToolPayload(deviceType).typed, length: parseToolPayload(deviceType).length }, { typed: true, length: "ccc-display-e2e".length });
        steps.push({ name: "device_type current display alias", status: "PASS" });

        for (const direction of ["up", "down", "left", "right"]) {
            const scroll = await callTool("scroll", { detail: true, deviceId: "x11-current-display", x: 1, y: 1, direction, amount: 1 });
            assert.notStrictEqual(scroll?.isError, true, `display_scroll ${direction}: ${scroll?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(scroll).scrolled, { x: 1, y: 1, direction, amount: 1 });
        }
        steps.push({ name: "display_scroll directions", status: "PASS" });

        for (const direction of ["up", "down", "left", "right"]) {
            const deviceScroll = await callTool("scroll", { detail: true, deviceId: displayDevice.deviceId, x: 1, y: 1, direction, amount: 1 });
            assert.notStrictEqual(deviceScroll?.isError, true, `device_scroll ${direction}: ${deviceScroll?.content?.[0]?.text || ""}`);
            assert.deepStrictEqual(parseToolPayload(deviceScroll).scrolled, { x: 1, y: 1, direction, amount: 1 });
        }
        steps.push({ name: "device_scroll current display alias directions", status: "PASS" });

        const deviceCursor = await callTool("cursor_position", { detail: true, deviceId: displayDevice.deviceId });
        assert.notStrictEqual(deviceCursor?.isError, true, `device_cursor_position: ${deviceCursor?.content?.[0]?.text || ""}`);
        cursorPoint(deviceCursor);
        steps.push({ name: "device_cursor_position current display alias", status: "PASS" });

        const flow = parseToolPayload(await callTool("run_flow", { detail: true,
            steps: [
                { tool: "status", arguments: { deviceId: "x11-current-display" } },
                { tool: "cursor_position", arguments: { deviceId: "x11-current-display" } },
                { tool: "status", arguments: displayDevice },
                { tool: "cursor_position", arguments: displayDevice },
            ],
        }));
        assert.strictEqual(flow.ok, true);
        assert.strictEqual(flow.results.length, 4);
        assert.strictEqual(flow.results[0].tool, "status");
        assert.strictEqual(flow.results[0].isError, false);
        assert.strictEqual(flow.results[0].content?.[0]?.value?.deviceId, "x11-current-display");
        assert.strictEqual(flow.results[0].content?.[0]?.value?.available, true);
        assert.strictEqual(flow.results[1].tool, "cursor_position");
        assert.strictEqual(flow.results[1].isError, false);
        assert.strictEqual(typeof flow.results[1].content?.[0]?.value?.x, "number");
        assert.strictEqual(typeof flow.results[1].content?.[0]?.value?.y, "number");
        assert.strictEqual(flow.results[2].tool, "status");
        assert.strictEqual(flow.results[2].isError, false);
        assert.strictEqual(flow.results[2].content?.[0]?.value?.deviceId, "x11-current-display");
        assert.strictEqual(flow.results[3].tool, "cursor_position");
        assert.strictEqual(flow.results[3].isError, false);
        steps.push({ name: "run_flow", status: "PASS" });
    }, { name: "ccc-real-display-e2e" });

    return { ...aggregateStepResult(steps), steps, scriptedArgumentFacets };
}
