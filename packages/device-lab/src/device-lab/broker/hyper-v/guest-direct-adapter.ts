import { win32 } from "path";

import {
    createHyperVGuestDirectClient,
    type HyperVGuestDirectAction,
    type HyperVGuestDirectIdentity,
    type HyperVGuestDirectResult,
} from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

export async function invokeDeviceLabHyperVGuestDirect(
    options: Omit<DeviceLabHyperVWindowsClientOptions, "session" | "record"> & {
        readonly identity: HyperVGuestDirectIdentity;
        readonly action: HyperVGuestDirectAction;
    },
): Promise<HyperVGuestDirectResult> {
    // Deliberately do not accept a pooled session here. This request contains a credential path
    // and may contain a guest command; every action receives its own child process.
    const client = createHyperVGuestDirectClient(createDeviceLabHyperVWindowsExecutor({
        executable: options.executable,
        timeoutMilliseconds: options.timeoutMilliseconds,
        run: options.run,
    }));
    const deadline = Date.now() + (typeof options.timeoutMilliseconds === "function"
        ? options.timeoutMilliseconds() : options.timeoutMilliseconds);
    const invoke = (action: HyperVGuestDirectAction) => client.invoke(
        { ...options.identity, ...action },
        Math.max(1, deadline - Date.now()),
    );
    if (options.action.action === "upload") {
        const parent = win32.dirname(options.action.remotePath);
        await invoke({ action: "mkdir", remotePath: parent });
    }
    return invoke(options.action);
}
