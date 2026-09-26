import { createDeviceLabHyperVWindowsClient, type DeviceLabHyperVWindowsClientOptions } from "./lifecycle-adapter.js";
import type { HyperVWindowsGuestBootDiagnostic } from "../../../hyper-v-windows/index.js";

export type DeviceLabHyperVGuestBootDiagnosticOptions = DeviceLabHyperVWindowsClientOptions & {
    readonly vmId: string;
    readonly vmName: string;
    readonly ownershipNotes: string;
};

export async function readDeviceLabHyperVGuestBootDiagnostic(
    options: DeviceLabHyperVGuestBootDiagnosticOptions,
): Promise<HyperVWindowsGuestBootDiagnostic> {
    const client = createDeviceLabHyperVWindowsClient(options);
    return client.getVMDiagnostic({
        selector: { kind: "id", id: options.vmId },
        expectedName: options.vmName,
        expectedNotes: options.ownershipNotes,
    }, { timeoutMilliseconds: typeof options.timeoutMilliseconds === "function"
        ? options.timeoutMilliseconds() : options.timeoutMilliseconds });
}
