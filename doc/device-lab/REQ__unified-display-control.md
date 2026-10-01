# Unified display control

CCC exposes its container display through Device Lab, using
`deviceId: "x11-current-display"` with the same `screenshot`, `click`,
`double_click`, `move`, `type`, `key`, `scroll`, and `cursor_position` tools as
other devices. Each action requires its deviceId and takes no backend selector.
No shared selected-device state is introduced.

The standalone X11 MCP package, build, published files, image copies, and bundle
synchronization are removed. Device Lab retains its X11 provider; CCC retains
Xvfb, xdotool, scrot, and the clipboard/display bridge. Removing the duplicate
server must preserve current-display discovery, screenshots and input behavior.
Incremental builds must remove obsolete generated `dist/x11-mcp` files, so
neither npm packages nor Unix installation payloads ship the deleted server.

Generated Claude and Codex configuration contains one managed Device Lab
display-control server. Legacy CCC-owned X11 entries, including Codex nested
environment tables, are removed. Unrelated custom MCP servers, their nested
tables and user settings are preserved; an arbitrary name containing `x11`
does not establish CCC ownership.

Verify with config preservation fixtures, a seeded obsolete output, extracted
distribution execution without node_modules, and actual Device Lab controls.
The provider uses display :99; changing DISPLAY alone does not isolate it.
Use an isolated display unless the user explicitly authorizes the current
screen, as authorized for this change. On the current screen, operate only an
owned temporary test window, restore the original focus and cursor even on
failure, and close only the test's own window and process. Windows Hyper-V
native acceptance is independent of this change.
