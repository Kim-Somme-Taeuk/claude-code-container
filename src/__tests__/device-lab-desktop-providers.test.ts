import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { desktopDragValid, desktopPointValid, X11_DRAG_COMMAND } from '@ccc/device-lab/providers/display/desktop-input.mjs';
import { macosGuestHelperScript, macosScreenshotCommand } from '@ccc/device-lab/providers/backends/macos-vm.mjs';
import { windowsHelperScript } from '@ccc/device-lab/providers/backends/windows-sandbox.mjs';

describe('desktop provider pointer controls', () => {
    it('rejects incomplete, fractional, nonnumeric and unbounded input before interaction', () => {
        expect(desktopDragValid({ x1: 0, y1: 0, x2: 20, y2: 20 })).toBe(true);
        for (const value of [undefined, '2', NaN, Infinity, -1, 1.5, 2147483648]) expect(desktopPointValid(value, 1)).toBe(false);
        for (const durationMs of [0, -1, 10001, 1.2, '10']) expect(desktopDragValid({ x1: 0, y1: 0, x2: 1, y2: 1, durationMs })).toBe(false);
    });
    function x11(fail: boolean, outside = false) {
        const dir = mkdtempSync(join(tmpdir(), 'desktop-input-'));
        const log = join(dir, 'calls');
        writeFileSync(join(dir, 'xdotool'), `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
case "$1" in
 getdisplaygeometry) echo '100 100';;
 mousemove) if [ "$FAIL_MOVE" = yes ] && [ -e "$LOG.down" ]; then exit 3; fi;;
 mousedown) touch "$LOG.down";;
esac
`, { mode: 0o755 });
        try {
            const result = spawnSync('bash', ['-c', X11_DRAG_COMMAND, 'test', '10', '10', outside ? '100' : '30', '30', '1'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, FAIL_MOVE: fail ? 'yes' : 'no' } });
            return { result, calls: readFileSync(log, 'utf8').trim().split('\n') };
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    it.skipIf(process.platform === 'win32')('executes a genuine X11 drag and releases left button on success', () => {
        const { result, calls } = x11(false);
        expect(result.status, result.stderr).toBe(0);
        expect(calls).toContain('mousedown 1');
        expect(calls).toContain('mousemove --sync 30 30');
        expect(calls.at(-1)).toBe('mouseup 1');
    });
    it.skipIf(process.platform === 'win32')('releases X11 left button after a movement failure without hiding failure', () => {
        const { result, calls } = x11(true);
        expect(result.status).toBe(3);
        expect(calls.at(-1)).toBe('mouseup 1');
    });
    it.skipIf(process.platform === 'win32')('rejects off-screen X11 endpoints before mouse down', () => {
        const { result, calls } = x11(false, true);
        expect(result.status).not.toBe(0);
        expect(calls.some(c => c.startsWith('mousedown'))).toBe(false);
    });
    function mac(mode: string, fail: boolean, outside = false) {
        const script = macosGuestHelperScript({ id: 'test' });
        const jxa = script.split('  drag|move)')[1].split("<<'JXA'\n")[1].split('\nJXA')[0];
        const events: string[] = [];
        const native = { CGDisplayBounds: () => ({ size: { width: 100, height: 100 } }), CGMainDisplayID: () => 1,
            CGPointMake: (x: number, y: number) => ({ x, y }), kCGMouseButtonLeft: 0, kCGHIDEventTap: 0,
            kCGEventMouseMoved: 'move', kCGEventLeftMouseDown: 'down', kCGEventLeftMouseDragged: 'drag', kCGEventLeftMouseUp: 'up',
            CGEventCreateMouseEvent: (_: unknown, kind: string) => { if (fail && kind === 'drag') throw Error('native failure'); return kind; },
            CGEventPost: (_: unknown, event: string) => events.push(event) };
        let error: unknown;
        try { runInNewContext(jxa + '\nrun(args)', { ObjC: { import() {} }, $: native, delay() {}, args: [mode, '10', '10', outside ? '100' : '30', '30', '1'] }); }
        catch (caught) { error = caught; }
        return { events, error };
    }
    it('macOS emits actual movement and drag events with finally release', () => {
        expect(mac('move', false).events).toEqual(['move']);
        expect(mac('drag', false).events).toEqual(['move', 'down', ...Array(20).fill('drag'), 'up']);
        const failed = mac('drag', true);
        expect(String(failed.error)).toContain('native failure');
        expect(failed.events).toEqual(['move', 'down', 'up']);
        expect(mac('drag', false, true).events).toEqual([]);
    });
    it('Windows generated and packaged helper controls match, with release and foreground verification', () => {
        const packaged = readFileSync('packages/device-lab/providers/backends/windows-helper.ps1', 'utf8');
        const generated = windowsHelperScript({ guestInboxDir: 'in', guestOutboxDir: 'out', guestUploadsDir: 'up', guestDownloadsDir: 'down' });
        const controls = (s: string) => s.slice(s.indexOf("        'drag' {"), s.indexOf("        'window_list' {"));
        expect(controls(generated)).toBe(controls(packaged));
        expect(controls(generated)).toContain('finally { [CccMouse]::mouse_event(4');
        expect(controls(generated)).toContain('GetForegroundWindow() -ne $Handle');
        expect(controls(generated).indexOf('drag-outside-display')).toBeLessThan(controls(generated).indexOf('mouse_event(2'));
    });
});


describe.skipIf(process.platform === 'win32')('macOS screenshot coordinate normalization', () => {
    function capture(mode: string) {
        const dir = mkdtempSync(join(tmpdir(), 'mac-screen-'));
        writeFileSync(join(dir, 'osascript'), `#!/bin/sh
cat >/dev/null
if [ "$MODE" = changed ] && [ -f "$ROOT/captured" ]; then echo '1 800 600'; else echo '1 1440 900'; fi
`, { mode: 0o755 });
        writeFileSync(join(dir, 'screencapture'), `#!/bin/sh
printf '%s\\n' "$*" > "$ROOT/capture-args"
touch "$ROOT/captured"
`, { mode: 0o755 });
        writeFileSync(join(dir, 'sips'), `#!/bin/sh
if [ "$1" = --resampleHeightWidth ]; then
  printf '%s %s' "$2" "$3" > "$ROOT/resample-args"
  [ "$MODE" != resizefail ] || exit 7
else
  if [ "$MODE" = wrongsize ]; then echo 'pixelWidth: 2880'; else echo 'pixelWidth: 1440'; fi
  echo 'pixelHeight: 900'
fi
`, { mode: 0o755 });
        try {
            const result = spawnSync('sh', ['-c', macosScreenshotCommand(join(dir, "screen ' special.png"))], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ROOT: dir, MODE: mode } });
            return { result, capture: readFileSync(join(dir, 'capture-args'), 'utf8'), resize: readFileSync(join(dir, 'resample-args'), 'utf8') };
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    it('captures only main display and resamples Retina pixels to CGEvent coordinates', () => {
        const result = capture('normal');
        expect(result.result.status, result.result.stderr).toBe(0);
        expect(result.capture).toContain('-x -m -t png');
        expect(result.capture).toContain("screen ' special.png");
        expect(result.resize).toBe('900 1440');
    });
    it.each(['resizefail', 'wrongsize', 'changed'])('does not return an incorrectly scaled capture on %s', mode => {
        expect(capture(mode).result.status).not.toBe(0);
    });
});
