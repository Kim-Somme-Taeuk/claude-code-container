# Device Lab responses and inspectable flows

Device Lab flows now return requested screenshots and other native content in the
same response, with per-step content ranges and accurate MCP error flags. Images
already captured survive later failures. QEMU output omits generated execution
wiring and repeated successful process observations; Sandbox/macOS inventory
removes duplicate discovery while retaining prerequisites and contention facts.
Current identity/readiness, artifacts, unique failures/recovery and opaque data
remain available, with raw diagnostic detail on request. The representative
50-observation QEMU fixture shrinks from 34,600 to 879 JSON bytes. Failed-flow
JSON text stays bounded to 64 KiB; native attachments are outside that bound.

Known ceiling: Unknown payload shapes and unique history are preserved. Native
platform/device execution is separate from Linux fixture and MCP stdio verification.
