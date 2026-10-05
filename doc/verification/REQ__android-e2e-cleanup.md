# Android destructive scenario cleanup

The Android real-test scenario owns only the uniquely named device it creates.
A valid successful creation response establishes cleanup responsibility even
when the normalized MCP payload has no top-level `ok` field. A later assertion
or operation failure must still attempt to stop and delete that fixture.
An unsuccessful create response must not establish ownership of an unrelated
device. Cleanup retains explicit destructive confirmation and the existing
provider ownership and liveness checks.

Cleanup must inspect MCP error responses and structured `ok: false` results,
not merely wait for the request promise. It attempts remaining cleanup after
an individual cleanup failure, reports cleanup failures alongside the original
failure, and does not claim success when fixture removal failed.

Verify normalized creation without `ok`, subsequent operation failure,
creation failure, returned MCP errors, structured cleanup errors, and successful
fixture removal. Actual Windows Level 3 success requires running that suite;
a container run with an explicitly supplied image does not validate Windows
SDK image discovery.
