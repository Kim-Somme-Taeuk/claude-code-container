# Host clipboard image detection

Concurrent Claude, Codex and X11 bridge reads previously shared native helper
stdout without response ownership. A marker response could be mistaken for an
empty clipboard snapshot, and a failed read could remain cached while the host
clipboard marker stayed unchanged. The fix serializes native snapshot reads,
requires complete response frames and valid snapshot data, and distinguishes
Windows/macOS persistent-helper read errors from a successfully read empty
clipboard. Failed reads can recover
without another host copy; the X11 bridge preserves its last valid selection
during an error. Native marker checks and bounded negative caching keep image,
text and empty transitions visible.

From the updated checkout on the Windows host, run `npm run install:global`,
then exit and reopen CCC. The clipboard server's content hash triggers an
automatic restart for the new code. Check image paste in both Claude and Codex,
then copy plain text, clear the clipboard, and copy the same image again.

Verification distinguishes actual HTTP/shell/X11 behavior and simulated native
protocol tests from execution on an interactive Windows desktop. The latter
is not available in the Linux development environment. The concurrent-reader
regression was reproduced against the previous commit: both Windows and macOS
protocol fixtures reported an empty clipboard while an image was present.
Focused checks cover concurrent Claude shell commands and the Codex image
reader, split Unicode frames, malformed/incomplete responses, multi-megabyte
image payloads, unchanged-marker recovery, and real Xvfb transitions through
image, text and empty selections. Existing text-copy invalidation tests remain
part of the regression checks.

## Known ceiling

Known ceiling: Native Windows desktop behavior remains unverified in this environment.
