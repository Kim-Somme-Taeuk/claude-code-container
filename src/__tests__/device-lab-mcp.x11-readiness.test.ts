import { describe, expect, it, vi } from "vitest";

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }));
vi.mock("fs", async (importOriginal) => ({
    ...await importOriginal<typeof import("fs")>(),
    existsSync: existsSyncMock,
}));

import { currentDisplayTarget, x11Available } from "../../device-lab-mcp/src/display/x11.mjs";

describe("current X11 display prerequisites", () => {
    it.each([
        { label: "neither tool", paths: [], available: false },
        { label: "only xdotool", paths: ["/usr/bin/xdotool"], available: false },
        { label: "only scrot", paths: ["/usr/bin/scrot"], available: false },
        { label: "both tools in /usr/bin", paths: ["/usr/bin/xdotool", "/usr/bin/scrot"], available: true },
        { label: "both tools in /bin", paths: ["/bin/xdotool", "/bin/scrot"], available: true },
        { label: "tools across both directories", paths: ["/bin/xdotool", "/usr/bin/scrot"], available: true },
    ])("reports readiness with $label", ({ paths, available }) => {
        existsSyncMock.mockImplementation((path: string) => paths.includes(path));
        const readiness = available
            ? { state: "ready" }
            : { state: "unavailable", reason: "missing-prerequisites" };

        expect(x11Available()).toBe(available);
        expect(currentDisplayTarget()).toEqual(expect.objectContaining({
            id: "x11-current-display",
            kind: "display",
            backend: "x11",
            display: ":99",
            creatable: false,
            attachable: false,
            lifecycle: "current",
            runtimeState: "current",
            available,
            readiness,
            capabilities: [
                "device_status", "device_screenshot", "device_click", "device_double_click",
                "device_key", "device_type", "device_scroll", "device_cursor_position",
                "display_screenshot", "display_click", "display_double_click", "display_key",
                "display_type", "display_scroll", "display_cursor_position",
            ],
            targetStatus: expect.objectContaining({
                targetKind: "current-display",
                creatable: false,
                attachable: false,
                runtimeState: "current",
                readiness,
                leaseState: { state: "not-required" },
                sessionState: expect.objectContaining({ state: "none" }),
            }),
        }));
    });
});
