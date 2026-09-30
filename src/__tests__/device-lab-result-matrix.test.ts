import { describe, expect, it } from "vitest";
import { assertResultMatrix, PROVIDER_RESULT_SPECS } from "../../scripts/real-tests/assert-matrix.js";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const imageTools = ["device_base_image_create", "device_base_image_clone"];

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
        expect(PROVIDER_RESULT_SPECS.flatMap((spec) => spec.tools).filter((tool) => !names.has(tool))).toEqual([]);
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

    it("requires explicit backend evidence for multi-backend tools", () => {
        expect(matrix(["device_create"]).ok).toBe(false);
        expect(matrix(["device_create"], (call) => ({
            ...call, facets: [`${call.tool}:backend=macos-vm`],
        })).ok).toBe(true);
    });
});
