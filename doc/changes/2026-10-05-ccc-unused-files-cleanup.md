# CCC unused-file cleanup

Removed the unused TypeScript iptables retry helper and its isolated tests;
production retries remain in `scripts/ccc-entrypoint.sh`. Removed its stale
compiled outputs explicitly because `tsc` does not delete outputs of removed
sources. Removed completed Copilot migration metadata and superseded June
device-lab autopilot bootstrap state; current device-lab contracts remain.

The local runtime cleanup removes obsolete CCC-owned images, unmounted test
volumes and the superseded mise cache, old Codex releases and Harness cache,
configuration backups, and abandoned test/diagnostic files. Current process,
container, mount, configuration and version references determine what is in
use. Authentication, session databases, project data, current runtime versions
and active containers are retained. No speculative backup copies are created.
This is one-time maintenance, not a change to `ccc clean` behavior.
