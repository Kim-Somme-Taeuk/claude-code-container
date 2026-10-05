---
slug: hyper-v-vm-computer-use
status: active
---

# Hyper-V VM computer use

## User outcome

An AI client can create and start an owner-scoped Windows or Linux Hyper-V VM, inspect its visible console as a PNG image, and use the existing `device_click`, `device_double_click`, `device_key`, `device_type`, `device_scroll`, and `device_cursor_position` tools to interact with that same VM. `device_backends` must advertise these capabilities only when the implementation supports them. Tool descriptions and errors must make the workflow understandable without reading source code.

## Observable contract

- `device_screenshot` returns an MCP PNG image and short metadata containing its pixel width, height, and capture time. The displayed image is the coordinate reference for mouse tools: origin `(0,0)` is its top-left pixel, and `(width-1,height-1)` is its bottom-right pixel.
- Mouse input targets the exact owner VM and converts image-relative coordinates to its native console coordinate system. Coordinates outside the image are rejected. A changed display geometry must not silently redirect a click.
- Keyboard input accepts a documented common key vocabulary and key combinations. Text input is Unicode and bounded to 2048 characters. On `windows-vm` it is sent through the console's `TypeText(asciiText)` in 128-character chunks, and only ASCII delivery is host-verified; on `linux-vm` it is sent in one `xdotool type` call in the guest desktop session. Unsupported keys or input devices return a specific error.
- Calls require a running, exact owner VM and verify its current incarnation. Capture and input never use the host desktop, a foreign VM, or a stale VM instance. Failed identity checks produce no input.
- If a guest has no usable graphical session, the MCP response identifies that condition and tells the caller what can prepare or unblock the display. A successful WMI method return alone does not establish that the guest UI changed.
- The first `device_start` automatically installs and starts a graphical session on the default Linux server image after verifying SSH identity. It is bounded and idempotent; `device_start` reports readiness only when the desktop is usable, or reports the failed stage. Later starts and reboots verify the session and repair it if needed. Screenshots never trigger package installation. The default Level 3 command includes Windows and Linux real-host GUI proof.

## Verification

Host-independent tests cover backend routing, owner and incarnation checks, WMI device association, image byte and size limits, coordinate mapping, key validation, timeouts, and failure responses. On each operating system, a real-host MCP test must capture a frame, perform mouse and keyboard actions against a visible target, and capture an observable change. Existing lifecycle Level 3 PASS results do not satisfy this GUI test.

The 2026-09-24 default Level 3 host run reached GUI proof in both guests. Windows created the keyboard-input guest file and displayed Notepad, but the wheel viewport assertion failed. Linux GUI proof failed with an overly generic redacted diagnostic. The scroll fixture now uses visibly distinct rows and bounded frame polling, and GUI failures carry safe stage codes. Both guests require a fresh host run before this proof can pass.

The next 2026-09-24 host run passed Windows GUI proof and localized Linux failure to `hyper-v-gui-keyboard-guest-file-missing`. The Linux proof now tries the desktop terminal shortcut, verifies the actual nonce file created through GUI keyboard input, and falls back to the XFCE application launcher if needed. It no longer assumes a terminal process or changed pixels imply keyboard focus. On GUI failure it saves a bounded VM screenshot before cleanup. Linux host proof remains pending a rerun.

The following host run again passed Windows and failed Linux at the nonce file check. Its saved image showed the terminal open but Application Finder still in front. Linux `device_type` now sends text through the owner-verified guest X11 session with `xdotool`, installed automatically during desktop readiness; it also checks the live Hyper-V VM identity and running state before input. The GUI proof activates and verifies the terminal window before typing. Key combinations and screenshots retain the Hyper-V console transport. This change needs another Linux host proof before completion can be claimed.

The 2026-09-24 Linux-only rerun stopped at `hyper-v-gui-linux-terminal-not-focused`. Its saved screen showed a foreground terminal, while the reported broker PID and start time were unchanged from before the X11 input change. The Level 3 launcher, CLI, and packaged MCP now require `hyper-v-linux-x11-type-v1`, so an older long-lived broker is replaced before a real run. The focus probe also reports a bounded stage (`tool-missing`, `display-unavailable`, `window-missing`, `activate-failed`, or `active-mismatch`) if it fails again. Real Linux host proof remains pending.

The 2026-09-25 default Level 3 host run passed Windows GUI proof end to end. Linux passed creation, desktop readiness, screenshots, pointer placement, clicks, and X11 typing, then failed at `hyper-v-gui-scroll-no-visible-effect`. Its saved frame showed the terminal unchanged at the bottom of its output after a 10-notch upward wheel. Hyper-V's synthetic-mouse `SetScrollPosition` reports success but does not reach the Linux X11 session, the same way WMI `TypeText` did not. Linux `device_scroll` now moves the pointer through the owner-verified console, then presses X11 wheel buttons (4 up, 5 down) at that pointer with `xdotool` in the verified desktop session. It reports provider `hyper-v-ssh-x11`. Windows keeps the console wheel. The Level 3 broker capability is `hyper-v-linux-x11-type-v2`, so an older broker is replaced before the next real run. Linux host proof remains pending that run.

The following Linux-only host run passed GUI proof, including X11 scrolling, then transfer, checkpoint create/list/restore/delete and stop. It failed only at the final `device_delete` with `hyper-v-device-cleanup-failed` after about 124 seconds. That matches the elevated-network handshake bound. The Linux E2E deleted without `preserveNetwork`, so removing the last allocation also tore down the shared managed switch, gateway and NAT. That needs an unattended UAC approval. The Linux E2E now uses the same delete options as Windows (`force`, `confirmDestructive`, `preserveNetwork`), pinned together in `hyper-v-vm-e2e.test.ts`.

**Host proof complete (2026-09-26).** The next Linux-only host run passed end to end (`SUMMARY real-tests total=1 pass=1`). Together with the 2026-09-25 default Level 3 run, in which Windows GUI proof passed, both guests now demonstrate screenshot → pointer/keyboard/scroll input → visible change through the packaged MCP on a real Hyper-V host.

## Known ceiling

- Known ceiling: the PowerShell `Capture-VMConsole`, `Send-VMConsoleInput` and `Get-VMConsoleCursor` operations have no Pester coverage. The parser gate checks their syntax, TypeScript tests cover the broker contract against a mocked runner, and the Windows host Level 3 GUI proof exercises them for real. A Pester suite needs a Windows PowerShell host.
- Known ceiling: non-ASCII `device_type` text on `windows-vm` goes to WMI `TypeText(asciiText)`. Host runs typed ASCII only, so it is unverified whether non-ASCII text such as Korean is delivered, rejected, or dropped. Use `device_exec`, or the guest clipboard, for non-ASCII input on Windows until that is proven.
