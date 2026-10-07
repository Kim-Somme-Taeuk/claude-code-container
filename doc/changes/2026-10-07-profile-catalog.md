# Separate profile catalog policy

Profile validation, reserved-default rules, list ordering and built-in ensure
decisions now live in a synchronous application behind six semantic ports. The
factory requires the default name supplied by the existing home-layout owner.
The public profile facade retains its exports and creates native bindings per
call; no import-time profile IO or storage migration is introduced.

Built-in own-property membership remains separate from settings access. Existing
and default profiles short-circuit before catalog reads; mutable getters and
null or undefined own entries retain their previous outcomes. Settings pass by
identity, errors propagate unchanged and no validation, normalization or retry
is added to create, ensure or remove.

Native storage retains its lazy root resolution and write sequence: `claude/`,
`codex/`, `claude.json`, then truthy settings serialization and
`claude/settings.json`. Directory and file creation options remain `0700` and
`0600`; these options do not reset existing permissions. Partial failures keep
preceding effects. Recursive forced removal and file-based existence behavior
remain unchanged.

Planned acceptance includes core, actual-facade and declaration tests, retained
profile/home-layout/index regressions, and compiled public behavior in both npm
and materialized installation payloads. Independent review and fresh QA are
still required; this note does not assert their result before execution.

## Known ceiling

This bounded M11 slice does not harden direct profile names, links or filesystem
races. Native Windows/macOS behavior remains unverified by portable Linux
fixtures. Profile request resolution, credential/home-layout migration, other
M11 workflows and M12–M14 remain separate work; the full architecture migration
is not complete.
