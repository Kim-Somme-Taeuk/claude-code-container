export const X11_WINDOW_LIST_COMMAND: string;
export function parseX11WindowList(stdout: string): { windows: Array<{handle: string; title: string; processId?: number}>; truncated?: boolean };
