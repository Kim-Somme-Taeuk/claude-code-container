# Canonical Device Lab tools and flows

Tool discovery now advertises 87 canonical tools instead of 93, while old names
remain callable. The canonical flow lists supported actions and accepts one
shared device target, reducing repeated arguments. Switching targets clears
inherited identity fields; confirmation and routing remain explicit per step.
Empty flows and malformed step arguments are rejected.

Legacy mobile dispatch remains unchanged, including its distinct Appium routes.
The quick start reuses returned device identities instead of prescribing extra
inventory and status calls. Catalog size decreases from 57,211 to 55,050 bytes.

The real-provider test runner now distinguishes accepted compatibility schemas
from discovery schemas and shares target-argument normalization with the server.
This keeps old provider scenarios valid and validates shared-target flows using
the same effective arguments, without relaxing strict coverage checks.
