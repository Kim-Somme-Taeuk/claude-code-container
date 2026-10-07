# Device lookup diagnostics

Registered tools requiring a device ID no longer report Unknown tool when direct
routing finds no handler. Terminal errors distinguish missing IDs, absent owned
devices, unsupported actions and ambiguous backend identity. Missing targets get
a short device_list hint. Existing validation, provider/broker errors and policy
refusals retain precedence; successful calls incur no additional lookup work.
The standalone MCP UX handoff was deleted at the user's request.
