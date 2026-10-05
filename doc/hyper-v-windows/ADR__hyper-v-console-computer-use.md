---
slug: hyper-v-console-computer-use
status: accepted
---

# Hyper-V console transport for Device Lab computer use

## Decision

Use the host Hyper-V WMI V2 console for screenshots, pointer positioning, clicks, and key combinations on both guests, and for text input and the mouse wheel on Windows. Route Linux text and mouse-wheel input through the automatically provisioned guest X11 session using owner-verified SSH and `xdotool`. For a Linux scroll, the pointer is still positioned through the console first. Text input also re-checks the native VM identity and running state first. Resolve the broker-owned VM by native ID and verify its name, Notes, state, and incarnation before touching the console. Capture the realized VM setting with `GetVirtualSystemThumbnailImage`; locate keyboard and mouse only through `Msvm_SystemDevice` associations of that VM. Keep the low-level operation typed and bounded, with the broker responsible for owner policy and MCP response shape.

## Reason

The console is shared by the two guest operating systems and can act before SSH or PowerShell Direct is ready. Existing diagnostic capture proves RGB565-to-PNG conversion on the Windows host, although its fixed 640×480 output and earlier WMI failures are insufficient as interactive proof. Input coordinates must be mapped from the returned image to the actual VM video mode, and the mapping must be tested on real hardware. A 2026-09-24 Linux host run showed WMI `TypeText` returning without an error while the requested guest file remained absent; its failure screenshot showed an open terminal and an Application Finder window retaining the text focus. Linux text input therefore uses the verified guest desktop session rather than treating WMI completion as proof of delivered characters. A 2026-09-25 Linux host run showed the same for the synthetic mouse wheel. Keyboard and clicks had passed, but a ten-notch `SetScrollPosition` left the terminal viewport unchanged in the saved frame, so the Linux wheel uses X11 buttons 4 and 5 at the console-positioned pointer.

## Alternatives and consequences

Guest agents or RDP can provide richer desktops but require a graphical login, guest packages, and network or service setup before the first screenshot. Linux X11 text and wheel input share that dependency, so it is available after automatic desktop readiness. The host-console choice still requires actual Windows and Linux input round-trip tests. WMI access may be restricted by UAC filtering; failures must be reported clearly without widening authority or operating on another VM.

The default Ubuntu cloud image has no desktop. After owner and SSH host identity checks, the first `device_start` provisions Xfce, `xdotool`, and the dedicated unprivileged `ccc-desktop` session, then waits for LightDM and Xorg. Reboots verify the session and repair it if needed. This avoids a separate public preparation tool; a screenshot remains a read-only operation and never installs packages. The default Windows and Linux Level 3 runs include the visible input proof.
