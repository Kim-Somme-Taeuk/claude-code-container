# Separate requested-tool setup policy

The existing `ensureTools` install selection, executable-readiness classification
and Codex sandbox postcondition now live in the requested-tool application behind
four semantic ports. The compatibility facade retains its signature and binds
the existing native installers and exact probe command. Mutable tool metadata,
raw observation reads, error messages and thrown-value identity retain their
original behavior; no retry or installer change is introduced.

Core, actual-facade and declaration tests cover the seam. The package verifier
checks the compiled application and facade delivery in extracted npm and
materialized installation payloads. The `void` effect ports rely on trusted
synchronous production bindings; they do not statically reject async callbacks.

Fresh verification also repaired a retained Codex launch fixture: its executable
index fragment now receives the existing session-confirmation binding. Controlled
promise cases check that confirmation is awaited and rejection prevents launch.
This corrects test construction without changing the production launch flow.

## Known ceiling

Known ceiling: no real installer, Docker/Podman, rootless or Windows/macOS
acceptance is established by this packet. Native npm/Claude/UV/bubblewrap policy,
other M11 workflows, M12–M14 and final M13 composition remain outstanding.
