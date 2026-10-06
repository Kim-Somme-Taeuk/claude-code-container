# Recover Linux workspace links during Windows builds

The workspace build now recognizes WSL/Linux links that Windows Node cannot
inspect (EACCES/EPERM, reparse tag `0xa000001d`) at the two literal runtime
dependency entries. After validating both entries, it rechecks the tag, removes
only reparse metadata and the empty local directory, and creates the normal
Windows junction. Generic permission errors, other reparse tags and physical
package contents remain protected. Native commands are bounded and use hidden
argument-array execution without a shell or elevation. Focused native-boundary
simulations complement the existing real compiler/import regressions; native
Windows rebuild acceptance still requires the user's Windows host.

Dockerfile and Containerfile also copy the new helper into mcp-builder. A recipe
import-closure regression checks both stages so npm packaging alone cannot mask
a missing builder input.
