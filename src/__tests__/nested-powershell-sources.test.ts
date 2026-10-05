import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nestedDevelopmentPrograms } from "../../scripts/nested-powershell-sources.mjs";
import { nestedClaimCommand, nestedCompleteClaimCommand } from "../../scripts/real-tests/nested-hyper-v-claim.ts";
import { NESTED_PREPARE_COMMAND, nestedLaunchCommand } from "../../scripts/real-tests/nested-hyper-v.ts";

vi.mock("node:child_process", async importOriginal => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

describe("nested PowerShell parser sources", () => {
    it.each(["invalid-json", "null", '[null,"prepare","launch"]', '["claim","complete","prepare",""]'])
        ("rejects missing or malformed collected programs: %s", stdout => {
            vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout, stderr: "", pid: 1, signal: null, output: [] });
            expect(() => nestedDevelopmentPrograms("unused")).toThrow("nested-development-programs-invalid");
        });
    it("reports collector process failure without exposing its output", () => {
        vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: "", stderr: "private-host-path", pid: 1, signal: null, output: [] });
        expect(() => nestedDevelopmentPrograms("unused")).toThrow(/^nested-development-programs-unavailable$/);
    });
    it("collects actual acquire, complete, prepare and launch sources without PowerShell", { timeout: 65000 }, () => {
        const programs = nestedDevelopmentPrograms(fileURLToPath(new URL("../../", import.meta.url)));
        expect(programs).toEqual([
            nestedClaimCommand("a".repeat(32)), nestedCompleteClaimCommand("a".repeat(32)),
            NESTED_PREPARE_COMMAND, nestedLaunchCommand("a".repeat(32), "b".repeat(64), "22.23.2", "windows"),
        ]);
        expect(programs[0]).toContain("-Operation 'acquire'");
        expect(programs[1]).toContain("-Operation 'complete'");
        expect(programs[2]).toContain("Install-WindowsFeature Hyper-V");
        expect(programs[3]).toContain("Start-ScheduledTask");
    });
});
