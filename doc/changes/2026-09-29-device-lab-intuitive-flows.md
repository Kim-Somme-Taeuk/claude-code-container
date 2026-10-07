# Intuitive Device Lab flows

Tool descriptions distinguish device selection, prerequisites, recorded status and active readiness, correct boot-wait boolean guidance, and explain fixed flow arguments and screenshot summaries. All 93 tool names and non-description schema fields remain unchanged; serialized catalog size decreases from 57,496 to 57,215 bytes. Within either verification flow, an explicit unmet text/app wait now fails its step and stops subsequent actions by default. Explicit continuation keeps running while the flow remains unsuccessful. Standalone wait observations and existing provider errors retain their semantics.

## Known ceiling

This does not change broker Appium end-to-end deadlines, iOS process-observation error classification, or direct unknown-device routing diagnostics. Updated MCP code requires a new server process; native Windows/macOS verification remains separate.
