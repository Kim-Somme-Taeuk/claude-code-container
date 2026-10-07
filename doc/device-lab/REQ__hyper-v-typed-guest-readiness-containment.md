---
area: device-lab
slug: hyper-v-typed-guest-readiness-containment
status: current
---

# REQ — Typed Windows guest readiness and containment

## Production readiness

Windows VM `device_start` and `device_reboot` with `waitForBoot` enabled MUST
probe readiness through typed Hyper-V Windows operations. The broker MUST verify
the owner-private credential and computed provisioning ISO paths before the
probe. Each guest probe MUST use an isolated one-shot process and a bounded
PowerShell Direct job attempt of at most 15 seconds. The overall readiness
budget MUST remain capped by the configured boot timeout and operation deadline,
with cleanup time reserved. The transport MUST NOT automatically replay a lost
or uncertain job response. Readiness MAY issue a new read-only probe on its
next explicit retry.

After the first valid structured probe, an unchanged Windows readiness
observation MUST be bounded to five minutes. The observation fingerprint is the
first-logon marker, provisioning-secret flag, and normalized IPv4 address set.
A change to any of those fields resets the five-minute budget. A repeated
identical bounded PowerShell Direct transport reason shares the same five-minute
budget; a different transport reason or a valid probe resets it. Malformed or
unclassified probe output clears the stable-observation evidence and remains
governed by the overall boot timeout.

The library MAY run a generic bounded guest script and return bounded data, but
MUST NOT encode CCC's first-logon registry, Panther file, ownership marker or
owner-root rules. Device Lab supplies a fixed probe and validates its exact
result: computer name, addresses, incarnation-bound first-logon marker and a
literal boolean for provisioning-secret presence.

## Scrub, media and network order

The first-logon marker MUST equal this device incarnation's expected marker,
then the probe MUST report no provisioning secrets. Only after both checks may
readiness set `scrubConfirmed`. It MUST then find at most one DVD attachment for
the computed provisioning ISO, remove it through an exact typed VM operation,
and confirm no matching attachment remains before setting `mediaDetached`.
An absent matching drive counts as detached only after an exact read. A lost
removal response MUST be inspected without repeating the removal. The host ISO
MUST be deleted only after confirmed detachment and with owner-path and reparse
checks. The expected network address is checked after media cleanup.

Readiness failures MUST carry a bounded reason, attempt count, `scrubConfirmed`
and `mediaDetached`. Unknown evidence is false. Both flags persist across
attempts. Public success and failure shapes and status classification remain
compatible with the current broker.

## Containment

The broker MUST capture its boot diagnostic before a containment stop. It MUST
compute the provisioning ISO path from the owner/device identity and treat an
unreadable path as retained. A named unscrubbed reason or retained media requires
force stop unless both scrub and detachment have been proven. `Off` and
`OffCritical` do not need a stop. A failed required stop MUST appear in the
response and persisted `lastBootCheck` so a running guest with mounted plaintext
media is not silently left uncontained.

## Verification

Tests MUST cover malformed probe output, job timeout, missing marker, retained
secrets, ambiguous and absent DVD, uncertain detachment, ISO cleanup failure,
network mismatch after scrub, stable-observation timeout, probe and transport
progress reset, malformed-probe overall timeout, deadline reserve and all
containment branches.
Linux simulation cannot prove native PowerShell Direct behavior; the parent
Goal retains Windows host syntax and live VM proof.
