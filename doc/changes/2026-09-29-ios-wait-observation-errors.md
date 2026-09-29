# iOS Simulator app observation errors

App waits now report simulator query failures as MCP errors instead of claiming
the app is absent. Each polling sweep independently tracks usable observations;
the final sweep determines clean absence or failure, so an earlier clean query
cannot hide a later loss of observation. The existing pgrep/launchctl fallback
order, positive-match responses and ownership checks remain intact. Failure
causes such as ENOENT, signals and stderr are retained in a bounded diagnostic.

## Known ceiling

This changes observation classification, not polling deadlines. Individual
commands retain their independent timeout; Linux fixture verification does not
replace native macOS/iOS validation. Unknown-device routing diagnostics and
broker Appium end-to-end deadlines remain in the Device Lab handoff.
