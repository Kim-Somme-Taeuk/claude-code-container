# Recover selected-tool launchers from verified cache

A missing npm-tool launcher can be rebuilt from a verified persisted Node 22
executable. Explicit cache absence installs only the selected package; failed or
ambiguous verification stops setup before installation. The existing tool setup
application, final launcher check and Codex sandbox preparation remain in place.

This is the independently verifiable selected-tool part of PR #9's repair intent.
PR #10 carries the shared credential-access, identity, session and other
integration changes. Both existing PRs are intended to be recorded as Merged
into `feature/device-mcp-squashed` after verification and authenticated
publication; this document does not claim either remote merge has occurred.

## Known ceiling

Native platform acceptance remains separate from portable shell and runtime
fixture evidence. This slice does not add OpenCode data-root preparation or
change credential ownership, profile resolution, session authority or caches'
runtime-identity namespaces.
