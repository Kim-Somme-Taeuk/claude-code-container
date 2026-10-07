# Container text copy to host

The clipboard shims previously consumed copied text without sending it anywhere
and exited successfully. The X11 bridge also only imported the host clipboard,
so direct X11 clients such as arboard-based TUIs could not copy text back.

The fix adds authenticated UTF-8 text writes to the host clipboard server and
connects shell copy commands and local X11 CLIPBOARD changes to that endpoint.
The [text-copy requirement](../common/REQ__clipboard-text-copy.md) defines byte
preservation, upload limits, failures and synchronization precedence. Existing
host-to-container image paste remains supported.

On a Windows host, run `npm run install:global` from the updated checkout, then
exit and reopen the CCC session. The host daemon refreshes when its compiled
content changes; container synchronization supplies the updated bridge and copy
commands even when another session keeps the container running. Copy a short Korean/emoji sample using the application's copy action
and paste into a host editor. `printf 'CCC copy test' | xclip -selection clipboard`
inside the container separately checks the command-based path.

CCC does not redefine Ctrl+C. In a terminal where Ctrl+C sends an interrupt, use
the terminal or TUI's copy action. This change also does not add clipboard
integration for Hyper-V guest desktops or reverse image/file transfer.

Verification must distinguish isolated Linux X11/HTTP integration and native
command-contract tests from a real Windows clipboard test. A Linux container
alone cannot confirm the latter on the user's interactive Windows desktop.

Automated checks exercise the real HTTP handler, actual shell commands and a
private Xvfb display. In particular, image-only X11 selections are not treated as
text merely because an X11 owner returns bytes for a requested text target; the
bridge verifies the advertised targets first. Tests also cover copy during a slow
host read, retry after failure, token changes, singleton startup and safe bridge
replacement without terminating an unrelated process.

An ephemeral container using the existing `ccc:latest` image also verified
script installation under root-owned `/usr/local/bin`, `ccc:ccc` mode-700 state,
unprivileged bridge/Xvfb startup and reuse after repeated synchronization. Native
Windows clipboard behavior still requires the interactive-host check above.
