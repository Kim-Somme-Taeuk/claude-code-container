import { actionResult } from "./action-output.mjs";
import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";

export const INVENTORY_BACKENDS = Object.freeze([
    "android-emulator", "android-device", "ios-simulator", "ios-device",
    "windows-sandbox", "windows-vm", "macos-vm", "linux-vm",
]);

// Reuse exactly the focused inventory route: host candidates must never silently
// fall back to the container's provider binaries. Limit in-flight broker requests.
export async function availableDevices(invoke, { detail = false } = {}) {
    const backends = new Array(INVENTORY_BACKENDS.length);
    let next = 0;
    async function collect() {
        while (next < INVENTORY_BACKENDS.length) {
            const index = next++;
            const backend = INVENTORY_BACKENDS[index];
            try {
                const raw = await invoke(backend);
                const result = actionResult("devices", "device_inventory", raw, { detail });
                const text = result?.content?.find(item => item.type === "text")?.text;
                const payload = JSON.parse(text || "null");
                if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid-inventory-result");
                backends[index] = { ...payload, backend };
                if (result.isError && !backends[index].error) backends[index].error = "inventory-unavailable";
            } catch (error) {
                backends[index] = { backend, error: "inventory-unavailable", detail: String(error?.message || error).slice(0, 300) };
            }
        }
    }
    await Promise.all([collect(), collect()]);
    const failures = backends.filter(entry => entry.error || entry.ok === false);
    return jsonResult({ backends, ...(failures.length ? { partial: true } : {}) });
}
