# Explicit tool preference application

## Explicit tool preference application (M11c candidate)

Saved default-tool decoding, save forwarding and the override -> saved ->
default resolution now live in `src/application/tool-preferences.ts` behind the
semantic `ToolPreferencePorts` in `src/ports/tool-preferences.ts`. The existing
`src/tool-detect.ts` stays the compatibility facade with the same three exports
and signatures, builds the application per call, keeps the `CCC_TOOL` read in its adapter, and wires the unchanged
`readCccConfig`/`updateCccConfig` adapters (`defaultTool` key, other keys
preserved, invalid JSON refused without a write) and the `tool-registry` facade.
There is no user-visible behavior change; `src/index.ts` is untouched.

Known ceiling: tool discovery/install, workspaces, profiles and credentials (the
rest of M11), M12–M14 and native acceptance remain outstanding. Config hardening
was intentionally not added.
