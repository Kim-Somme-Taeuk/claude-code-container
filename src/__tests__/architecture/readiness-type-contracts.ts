import { waitForStartReadiness } from "../../../packages/device-lab/providers/application/start-readiness.mjs";
import type { ReadinessOutcome } from "../../../packages/device-lab/providers/domain/readiness.mjs";
import type { ReadinessPorts } from "../../../packages/device-lab/providers/ports/readiness.mjs";

// Compile-only consumer. No second declaration/implementation may drift from .mjs.
export async function checkReadinessContracts(ports: ReadinessPorts): Promise<ReadinessOutcome> {
    const result = await waitForStartReadiness(1000, ports);
    if (result.kind === "timed-out") {
        const attempts: number = result.readiness.attempts;
        void attempts;
    } else {
        // @ts-expect-error A ready outcome does not carry timeout evidence.
        void result.readiness;
    }
    // @ts-expect-error A transport cannot supply string readiness flags.
    const invalidProbe: ReadinessPorts["probe"] = async () => ({ ready: "yes", failed: false });
    // @ts-expect-error Sleep completion must be awaitable.
    const invalidSleep: ReadinessPorts["sleep"] = () => undefined;
    // @ts-expect-error The application requires an explicit clock, not ambient defaults.
    void waitForStartReadiness(1000, { probe: ports.probe, sleep: ports.sleep });
    void invalidProbe;
    void invalidSleep;
    return result;
}
