# Device Lab observation wait budgets

Mobile text/app waits share one observation allowance across commands, requests
and pauses after initial discovery/session setup. Broker polls also propagate
the remaining allowance through authentication and host execution. Ordinary
Appium requests retain their existing defaults; ownership and physical lease
checks remain. Incomplete or timed-out observations cannot establish a match
or absence. Completed clean non-matches retain absence results, including valid
simulator fallback observations; failed observations without that evidence stay errors.

## Known ceiling

This is not an exact wall-clock promise: bootstrap is excluded, and bounded
identity inspection, filesystem work, process termination and scheduling add
overhead. Matching host/client builds are required for underlying host request
cancellation. Fixture verification does not imply native iOS/Windows proof.
