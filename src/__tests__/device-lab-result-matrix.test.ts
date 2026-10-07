import { describe, expect, it } from "vitest";
import { assertResultMatrix, PROVIDER_RESULT_SPECS } from "../../scripts/real-tests/assert-matrix.js";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const imageTools = ["create_macos_vm"];

function matrix(tools = imageTools, change: (call: any) => any = (call) => call) {
    const calls = ["source", "dist"].flatMap((source) => tools.map((tool) => change({
        file: "/results/provider-e2e.ts", tool, outcome: "ok", mcpSessionId: source,
        facets: [`${tool}:provider=tart`],
    })));
    return assertResultMatrix([{
        host: { platform: "darwin" }, records: [],
        mcpSessions: ["source", "dist"].map((source) => ({ id: source, serverSource: source })),
        toolCoverage: { advertisedTools: tools, calls },
    }], {
        advertisedTools: tools, requireLinuxVm: false,
        providerSpecs: [{ id: "macos-vm", files: ["provider-e2e.ts"], tools }],
    });
}

describe("canonical provider result evidence", () => {
    it("requires only public tools, excluding internal provider aliases", () => {
        const names = new Set(TOOLS.map((tool) => tool.name));
        expect(PROVIDER_RESULT_SPECS.flatMap((spec) => spec.tools).filter((tool) => !names.has(tool.split(":")[0]))).toEqual([]);
    });

    it("credits successful sole-backend image calls without redundant backend input", () => {
        expect(matrix().ok).toBe(true);
    });

    it.each(["source", "file", "outcome", "conflicting-backend"])("does not credit invalid %s evidence", (kind) => {
        const result = matrix(imageTools, (call) => {
            if (kind === "source") return { ...call, mcpSessionId: "source" };
            if (kind === "file") return { ...call, file: "/results/other.ts" };
            if (kind === "outcome") return { ...call, outcome: "error" };
            return { ...call, facets: [`${call.tool}:backend=android-emulator`] };
        });
        expect(result.providerEvidence["macos-vm"].dist.missingTools).toEqual(imageTools);
        expect(result.ok).toBe(false);
    });

    it.each([1, 2])("credits double-click provider evidence only for count2, observed %s", count => {
        expect(PROVIDER_RESULT_SPECS.find(spec => spec.id === "windows-vm")?.tools).toContain("click:count=2");
        const result = assertResultMatrix([{ host: { platform: "win32" }, mcpSessions: ["source", "dist"].map(source => ({ id: source, serverSource: source })), toolCoverage: { advertisedTools: ["click"], calls: ["source", "dist"].map(source => ({ tool: "click", outcome: "ok", file: "provider-e2e.ts", mcpSessionId: source, facets: ["click:backend=windows-vm", `click:count=${count}`] })) } }], {
            advertisedTools: ["click"], requireLinuxVm: false,
            providerSpecs: [{ id: "windows-vm", files: ["provider-e2e.ts"], tools: ["click", "click:count=2"] }],
        });
        expect(result.providerEvidence["windows-vm"].dist.missingTools).toEqual(count === 2 ? [] : ["click:count=2"]);
        expect(result.ok).toBe(count === 2);
    });

    it("does not credit snapshot list for restore or delete on the same provider", () => {
        const calls = ["source", "dist"].map(source => ({ tool: "snapshot", outcome: "ok", file: "provider-e2e.ts", mcpSessionId: source, facets: ["snapshot:backend=windows-vm", "snapshot:action=list"] }));
        const result = assertResultMatrix([{ host: { platform: "win32" }, mcpSessions: ["source", "dist"].map(source => ({ id: source, serverSource: source })), toolCoverage: { advertisedTools: ["snapshot"], calls } }], {
            advertisedTools: ["snapshot"], requireLinuxVm: false,
            providerSpecs: [{ id: "windows-vm", files: ["provider-e2e.ts"], tools: ["snapshot:action=list", "snapshot:action=restore", "snapshot:action=delete"] }],
        });
        expect(result.providerEvidence["windows-vm"].dist.missingTools).toEqual(["snapshot:action=restore", "snapshot:action=delete"]);
    });

    it("requires explicit backend evidence for multi-backend tools", () => {
        expect(matrix(["create"]).ok).toBe(false);
        expect(matrix(["create"], (call) => ({
            ...call, facets: [`${call.tool}:backend=macos-vm`],
        })).ok).toBe(true);
    });
});
