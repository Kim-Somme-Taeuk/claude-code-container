import { describe, expect, it } from "vitest";
import { CLAUDE_BIN_PATH } from "../../domain/tool-layout.js";
import { CLAUDE_BIN_PATH as publicPath, type ClaudeLayoutPaths } from "../../container-setup.js";
import type { CredentialMount, ToolDefinition } from "../../tool-registry.js";

function compileContracts(tool: ToolDefinition, mount: CredentialMount, paths: ClaudeLayoutPaths) {
    const domain: "/home/ccc/.local/bin/claude" = CLAUDE_BIN_PATH;
    const compatible: typeof CLAUDE_BIN_PATH = publicPath;
    const publicLiteral: "/home/ccc/.local/bin/claude" = publicPath;
    const values: string[] = [tool.binary, mount.hostDir, mount.containerDir, paths.bin];
    // @ts-expect-error The old public path retains its literal type.
    const wrong: typeof publicPath = "/other/claude";
    // @ts-expect-error A path cannot become a number.
    const numeric: number = CLAUDE_BIN_PATH;
    void [domain, compatible, publicLiteral, values, wrong, numeric];
}
void compileContracts;

describe("shared launcher literal compatibility", () => {
    it("preserves the old public path", () => expect(publicPath).toBe(CLAUDE_BIN_PATH));
});
