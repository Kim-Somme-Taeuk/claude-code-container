import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { macosGuestHelperScript } from '@ccc/device-lab/providers/backends/macos-vm.mjs';
import { MACOS_WINDOW_JXA } from '@ccc/device-lab/providers/backends/macos-window-focus.mjs';

function fixture(ids: Array<string | null> = ['editor', 'other'], options: { denied?: boolean; launch?: number; permissionDenied?: boolean } = {}) {
    let focused: any = null;
    let frontmost = false;
    const raised: string[] = [];
    const windows = ids.map(id => ({
        attributes: { byName: (name: string) => {
            if (name === 'AXIdentifier') return { value: () => id };
            return { set value(_value: boolean) {} };
        } },
        actions: { byName: () => ({ perform: () => { raised.push(String(id)); if (!options.denied) focused = windows.find(win => win.attributes.byName('AXIdentifier').value() === id); } }) },
        name: () => 'same title', role: () => 'AXWindow', subrole: () => '', position: () => [0, 0], size: () => [800, 600],
    }));
    const process: any = { name: () => 'Editor', unixId: () => 42, windows: () => windows, attributes: { byName: () => ({ value: () => focused }) } };
    Object.defineProperty(process, 'frontmost', { get: () => () => frontmost, set: (value: boolean) => { frontmost = value; } });
    const context: any = {
        ObjC: { import: () => {} },
        $: { NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({ launchDate: { timeIntervalSince1970: options.launch ?? 1234 } }) }, NSThread: { sleepForTimeInterval: () => {} } },
        Application: () => ({ processes: { whose: () => () => { if (options.permissionDenied) throw Error('permission-denied'); return [process]; } } }),
    };
    runInNewContext(MACOS_WINDOW_JXA, context);
    return { call: (...args: string[]) => JSON.parse(context.run(args)), windows, raised, options };
}

describe('macOS opaque AX window focus', () => {
    it('embeds the tested JXA in the installed guest helper with argument forwarding', () => {
        const script = macosGuestHelperScript({ id: 'focus-fixture' });
        expect(script).toContain(MACOS_WINDOW_JXA);
        expect(script).toContain('window_list|focus_window)');
        expect(script).toContain('osascript -l JavaScript - \"$@\"');
    });
    it('lists unique identifiers as round-trip handles and focuses exact identifier despite same titles', () => {
        const state = fixture();
        const listed = state.call('window_list').windows;
        expect(listed[0].handle).toBe('macos:42:1234000:editor');
        expect(state.call('focus_window', listed[1].handle)).toEqual({ ok: true });
        expect(state.raised).toEqual(['other']);
    });
    it('omits handles for missing and duplicate identifiers', () => {
        const state = fixture([null, '', 'duplicate', 'duplicate', 'unique']);
        expect(state.call('window_list').windows.map((win: any) => win.handle)).toEqual([undefined, undefined, undefined, undefined, 'macos:42:1234000:unique']);
        expect(() => state.call('focus_window', 'macos:42:1234000:duplicate')).toThrow('window-handle-stale');
        expect(state.raised).toEqual([]);
    });
    it('rejects stale process launch identity before focusing', () => {
        const state = fixture(['editor'], { launch: 5678 });
        expect(() => state.call('focus_window', 'macos:42:1234000:editor')).toThrow('window-handle-stale');
        expect(state.raised).toEqual([]);
    });
    it('rechecks process incarnation after raise before reporting success', () => {
        const state = fixture(['editor']);
        state.windows[0].actions.byName = () => ({ perform: () => { state.options.launch = 5678; } });
        expect(() => state.call('focus_window', 'macos:42:1234000:editor')).toThrow('window-handle-stale');
    });
    it('does not report success when requested focus is denied', () => {
        const state = fixture(['editor'], { denied: true });
        expect(() => state.call('focus_window', 'macos:42:1234000:editor')).toThrow('window-focus-denied');
    });
    it('rejects malformed handles and propagates enumeration permission failure', () => {
        const state = fixture();
        for (const handle of ['42', 'macos:42:1234000:%ZZ', 'macos:42:1234000:%65ditor', 'macos:9999999999:1234000:editor']) expect(() => state.call('focus_window', handle)).toThrow();
        expect(state.raised).toEqual([]);
        expect(() => fixture([], { permissionDenied: true }).call('window_list')).toThrow('permission-denied');
    });
});
