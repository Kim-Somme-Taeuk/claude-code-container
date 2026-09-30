# Canonical Device Lab inputs

Device Lab MCP accepts the same 87 tool names it advertises. Redundant mobile
aliases and hidden administrative broker/image calls have been removed. Inputs
are flat; single-backend tools select their backend automatically. Flow steps
use `tool`, `arguments`, and optional `label`. Old names, `options` wrappers,
redundant backend selectors and `name` flow keys fail before device operations.
This intentionally breaks old calls in favor of one intuitive interface.
Screenshots, native flow content, ownership and destructive confirmation remain.
Every standalone device operation keeps an explicit `deviceId`; there is no
shared selected-device state. A flow may share its target within that request.

Provider coverage now checks canonical public tools and recognizes the declared
backend of single-backend tools without requiring removed input fields. Diagnostic
smokes request `detail` explicitly when asserting provider capabilities.

## Known ceiling

Internal transport controls remain available to existing route/test machinery;
their host-routing contracts require a separate design before removal. Tests
using isolated fixtures and real MCP stdio do not certify native host devices.
