// Public JXA/System Events + AppKit only. AXIdentifier support is intentionally partial.
export const MACOS_WINDOW_JXA = String.raw`
ObjC.import('AppKit');
function safe(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }
function identifier(win) {
  var value = safe(function () { return win.attributes.byName('AXIdentifier').value(); }, null);
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}
function incarnation(pid) {
  return safe(function () {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    var time = Math.floor(Number(app.launchDate.timeIntervalSince1970) * 1000);
    return Number.isSafeInteger(time) && time > 0 ? String(time) : null;
  }, null);
}
function handle(pid, launch, id) {
  return 'macos:' + pid + ':' + launch + ':' + encodeURIComponent(id);
}
function decode(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('invalid-window-handle');
  var match = /^macos:([1-9][0-9]{0,9}):([1-9][0-9]{0,15}):(.+)$/.exec(value);
  if (!match) throw Error('invalid-window-handle');
  var pid = Number(match[1]);
  var id = decodeURIComponent(match[3]);
  if (pid > 2147483647 || !Number.isSafeInteger(Number(match[2])) || !id || id.length > 512 || handle(pid, match[2], id) !== value) throw Error('invalid-window-handle');
  return {pid:pid, launch:match[2], id:id};
}
function run(args) {
  var systemEvents = Application('System Events');
  if (args[0] === 'window_list') {
    // Permission failures must be visible, not an apparently successful empty list.
    var processes = systemEvents.processes.whose({visible:true})();
    var windows = [];
    for (var p = 0; p < processes.length; p++) {
      var process = processes[p];
      var pid = process.unixId();
      var launch = incarnation(pid);
      var processWindows = process.windows();
      var ids = processWindows.map(identifier);
      for (var w = 0; w < processWindows.length; w++) {
        var win = processWindows[w];
        var entry = {processName:safe(function () { return process.name(); }, ''), processId:pid, title:safe(function () { return win.name(); }, ''), role:safe(function () { return win.role(); }, ''), subrole:safe(function () { return win.subrole(); }, ''), position:safe(function () { return win.position(); }, null), size:safe(function () { return win.size(); }, null)};
        if (launch && ids[w] && ids.indexOf(ids[w]) === ids.lastIndexOf(ids[w])) {
          var token = handle(pid, launch, ids[w]);
          if (token.length <= 2048) entry.handle = token;
        }
        windows.push(entry);
      }
    }
    return JSON.stringify({ok:true, provider:'macos-system-events', windows:windows});
  }
  var target = decode(args[1]);
  var matches = systemEvents.processes.whose({unixId:target.pid})();
  if (matches.length !== 1 || incarnation(target.pid) !== target.launch) throw Error('window-handle-stale');
  var process = matches[0];
  function resolveWindow() {
    if (incarnation(target.pid) !== target.launch) throw Error('window-handle-stale');
    var candidates = process.windows().filter(function (win) { return identifier(win) === target.id; });
    if (candidates.length !== 1) throw Error('window-handle-stale');
    return candidates[0];
  }
  var selected = resolveWindow();
  process.frontmost = true;
  selected.actions.byName('AXRaise').perform();
  // Some apps expose read-only focus attributes; the observed focus is decisive.
  safe(function () { selected.attributes.byName('AXMain').value = true; }, null);
  safe(function () { selected.attributes.byName('AXFocused').value = true; }, null);
  for (var attempt = 0; attempt < 20; attempt++) {
    resolveWindow();
    var focused = safe(function () { return process.attributes.byName('AXFocusedWindow').value(); }, null);
    if (process.frontmost() && focused && identifier(focused) === target.id) return JSON.stringify({ok:true});
    $.NSThread.sleepForTimeInterval(0.05);
  }
  throw Error('window-focus-denied');
}
`;
