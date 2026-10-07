# Resolve runtime workspace links before compilation

Source builds now validate the literal Hyper-V and Device Lab packages and their
dependency entries before removing build output. Missing or relocated symbolic
links are repaired to the current checkout; correct links stay unchanged.
Physical package entries and redirected parents are preserved and rejected with
dependency-install guidance. External link targets are never deleted.

The original missing-module error was reproduced using real NodeNext TypeScript
compilation with a dangling foreign-checkout link. Focused tests cover the
reported exported subpaths, Node runtime imports, repeated builds, preserved
external targets and rejection of ambiguous physical entries. Before the final
ENOTDIR edge-case correction, the complete portable build, 38 regression files
with 2,400 tests, lint and extracted npm/materialized package checks passed.
After that correction, all 12 focused workspace tests passed. The earlier broad
checks also include the separate session-exit candidate; neither those checks
nor the focused run are independent QA attestation.

## Known ceiling

Native macOS global installation and Windows junction permissions still require
their respective hosts. This checkout's broken foreign links prove a reproducible
failure mechanism, but the Mac's original link targets were not inspected.
Concurrent npm dependency mutation during a build is not a supported transaction.
Independent code/security/documentation reviews and fresh QA remain required.
