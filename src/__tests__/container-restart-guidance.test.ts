import { describe, expect, it } from "vitest";
import { ContainerRestartRequiredError, formatContainerStartupError } from "../container-restart-guidance.js";

describe("container restart guidance", () => {
    it("gives a supported stop command for the exact workspace without a stack or force flag", () => {
        const error = new ContainerRestartRequiredError("bind identity changed at /home/ccc/.claude.json", "/projects/PAY--DEV-208-28", "docker");
        const message = formatContainerStartupError(error);
        expect(typeof message).toBe("string");
        expect(message).toContain("Container restart required: bind identity changed at /home/ccc/.claude.json");
        expect(message).toContain("Close the other CCC sessions");
        expect(message).toContain("`ccc --runtime docker stop` from \"/projects/PAY--DEV-208-28\"");
        expect(message).not.toContain("CCC_PROFILE");
        expect(message).toContain("retry your original command");
        expect(message).not.toContain("--force");
        expect(message).not.toContain("\n    at ");
        expect(message).not.toContain("[cause]");
    });

    it("retains the runtime/profile and quotes a workspace containing spaces", () => {
        const message = formatContainerStartupError(new ContainerRestartRequiredError("project path identity changed", "C:\\Work Space\\repo", "podman", "work"));
        expect(message).toContain("`ccc --runtime podman stop`");
        expect(message).toContain(JSON.stringify("C:\\Work Space\\repo"));
        expect(message).toContain("CCC_PROFILE=work");
    });

    it("retains original errors in debug mode and for unexpected failures", () => {
        const expected = new ContainerRestartRequiredError("bind mismatch", "/workspace", "docker");
        expect(formatContainerStartupError(expected, true)).toBe(expected);
        const unexpected = new Error("unrelated setup failure");
        expect(formatContainerStartupError(unexpected)).toBe(unexpected);
        expect(formatContainerStartupError("unknown failure")).toBe("unknown failure");
    });
});
