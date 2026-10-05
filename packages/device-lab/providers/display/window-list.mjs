// Shared by the current display and the managed Hyper-V Linux desktop.
// Native identifiers are never executable shell input. Titles travel as base64
// so tabs, line breaks, quotes and non-ASCII text cannot alter framing.
export const X11_WINDOW_LIST_COMMAND = String.raw`set -eu
command -v xdotool >/dev/null || { echo window-list-xdotool-missing >&2; exit 1; }
xdotool getdisplaygeometry >/dev/null || { echo window-list-display-unavailable >&2; exit 1; }
status=0
ids=$(xdotool search --onlyvisible --name '.' 2>&1) || status=$?
if [ "$status" -ne 0 ]; then
  if [ "$status" -eq 1 ] && [ -z "$ids" ]; then exit 0; fi
  echo window-list-query-failed >&2; exit 1
fi
count=0
bytes=0
for id in $ids; do
  case "$id" in ''|*[!0-9]*) echo window-list-invalid-handle >&2; exit 1;; esac
  if [ "$count" -ge 128 ]; then printf 'TRUNCATED\n'; break; fi
  title=$(xdotool getwindowname "$id") || { echo window-list-window-changed >&2; exit 1; }
  [ -n "$title" ] || continue
  pid=$(xdotool getwindowpid "$id" 2>/dev/null) || pid=''
  case "$pid" in *[!0-9]*) pid='';; esac
  title=$(printf %s "$title" | head -c 4096 | base64 | tr -d '\n')
  bytes=$((bytes + ${"${#id}"} + ${"${#pid}"} + ${"${#title}"} + 3))
  if [ "$bytes" -gt 24000 ]; then printf 'TRUNCATED\n'; break; fi
  printf '%s\t%s\t%s\n' "$id" "$pid" "$title"
  count=$((count + 1))
done`;

export function parseX11WindowList(stdout) {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 1024 * 1024) throw new Error("window-list-invalid-result");
    const windows = [];
    let truncated = false;
    for (const line of stdout.trimEnd().split("\n").filter(Boolean)) {
        if (line === "TRUNCATED" && !truncated) { truncated = true; continue; }
        const parts = line.split("\t");
        if (truncated || parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d*$/.test(parts[1])
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parts[2]) || windows.length >= 128) {
            throw new Error("window-list-invalid-result");
        }
        const title = Buffer.from(parts[2], "base64").toString("utf8");
        if (Buffer.byteLength(title) > 4100) throw new Error("window-list-invalid-result");
        const processId = Number(parts[1]);
        windows.push({ handle: parts[0], title,
            ...(parts[1] && Number.isSafeInteger(processId) && processId > 0 ? { processId } : {}) });
    }
    return { windows, ...(truncated ? { truncated: true } : {}) };
}
