# Recover a selected npm tool's missing launcher

When the selected tool's launcher is absent, check the persisted Node 22
installation and invoke its actual tool executable with `--version`, bypassing
mise shims and unrelated PATH entries. Resolve Node offline with a bounded
lookup; bound tool verification and the outer runtime command.

Only an explicit `MISSING` observation permits cleanup and installation of the
selected npm package. An executable verification failure, timeout, killed probe
or malformed result must stop setup without reinstalling over the retained
package. A `READY` observation repairs the launcher without installing packages.
Retain the existing final launcher check and Codex sandbox preparation.

Verify cache reuse, explicit absence, failures, wrapper-write failures, quoted
arguments and a PATH decoy using private fixtures. Do not infer native Docker,
Podman, Windows or macOS acceptance from a mocked runtime dispatch.
