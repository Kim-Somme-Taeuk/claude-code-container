# Preserve fork fixes on upstream 1.1.90

This integration adopts upstream's package layout, container lifecycle, profiles,
native tool installation and Codex daemon/resume handling while retaining the
fork's host UID/GID alignment, scoped caches, verified retained-state migration,
config access, clipboard continuity, SSH preparation and remembered mise refusal.
Running containers remain intact; updates wait for a stopped container. Failed
tool probes return their original error without deleting working installations.
Harness engine changes remain separate from CCC's bootstrap and path integration.

## Known ceiling

SSH refresh preserves container-learned host keys only while private provenance
matches the authoritative host file. Missing provenance or any authority change
resets learned trust, including hashed or wildcard entries; those additional
hosts require verification again. SSH snapshot entries larger than 16 MiB fail
preparation and invalidate the incomplete snapshot.

The [preservation contract](../runtime/REQ__upstream-fork-preservation.md) maps the
fork changes to their current implementations. The
[ownership contract](../runtime/REQ__host-project-ownership.md) specifies supported
identity mappings and the conditions that refuse migration rather than alter
unproven state.
