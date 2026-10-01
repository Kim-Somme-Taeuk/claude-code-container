# Environment-independent regression tests

Tests that simulate a runtime must control its relevant environment inputs and
restore them afterward. Native Linux Docker fixtures clear inherited WSL
variables; separate WSL NAT and mirrored-network fixtures set their inputs
explicitly. Keep production detection behavior intact when a mock accidentally
inherits the developer's machine configuration.

X11 display enumeration describes the current display even when its required
tools are missing. Integration assertions must account for the actual prerequisite
state. Deterministic tests separately arrange neither tool, either tool, and both
`xdotool` and `scrot`, asserting unavailable/ready state, the missing-prerequisite
reason, and unchanged display identity and lifecycle. Do not install packages on
the developer's host or mark an unavailable provider ready to satisfy a test.

For `npm pack --dry-run --json`, select and validate the expected package record
from either an array or a package-name-keyed object. Check the record's name and
its file-path array before evaluating all required artifact assertions. A JSON
error object, missing package, duplicate matching array records, or malformed
files must fail; output-shape compatibility must not hide missing shipped files.

Owner-resolution integration tests use real broker HTTP and process boundaries.
Client requests use the same canonical project mount derivation as owner
identity. Preserve registered-owner, profile, malformed-request, secret and
concurrency checks while fixing successful host and container client flows.

During parallel implementation, run focused Vitest commands directly; the
coordinator owns shared generated builds. For final verification, run `npm test`,
which builds before the suite. Do not run another build or full suite concurrently
against the same generated output tree.

Bundled MCP dispatch smoke tests control child PATH, display variables, user-home
and Android SDK roots using temporary fixtures. Launch the bundled Node server
with the absolute Node executable; keep all advertised schema and tool dispatch
assertions, including structured unavailable-provider responses. Inheriting host
PATH can repeatedly scan slow mounted Windows directories or discover real host
tools. These fixtures reduce host dependence; they are not a security sandbox.
Real device/provider validation remains in the dedicated integration suites.

For CLI integration tests, allow the outer test deadline to cover the sum of
sequential child-process deadlines plus overhead. For example, a 60-second setup
followed by a 30-second removal needs more than 90 seconds. Keep bounded child
timeouts and assert setup and command exit codes; a failed setup must not make a
later cleanup assertion look successful.

Before taking a command-log baseline to prove a rejected operation has no side
effects, observe any asynchronous command from the preceding successful action.
For the Windows singleton fixture, wait for that sandbox's initial `wsb connect`
entry and assert it was observed before checking duplicate-start log equality.
Otherwise a late initial connection can look like a side effect of the rejection.
