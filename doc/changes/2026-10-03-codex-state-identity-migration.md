# Retained Codex state after identity changes

CCC now migrates its retained `~/.ccc/codex` ownership before replacing a stopped
container with a different native host identity. It verifies the old account
from the previous image, limits changes to matching IDs, and serializes shared
state startup across projects. Active users or unsafe filesystem entries stop
the migration while preserving the previous container. Codex startup checks
private state access before Harness bootstrap and reports when already-replaced
state needs verified offline recovery. The host's separate `~/.codex` and project
files remain outside this migration. See the
[ownership requirements](../runtime/REQ__host-project-ownership.md), including
the limitation for unresolvable active bind sources.
