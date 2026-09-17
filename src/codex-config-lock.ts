import { dirname, join } from "path";
import { getCodexConfigFile } from "./utils.js";
import { withSharedMutationLock } from "./device-lab-shared-state.js";

// All projects share this config. Keep the lock host-owned, outside the
// credential directory shared with the container user.
export function withCodexConfigLock<T>(operation: () => T): T {
    if (process.env.container === "docker") {
        throw new Error("Codex configuration cannot be changed from inside a container because the host configuration lock is unavailable. Run CCC from the host shell.");
    }
    const lock = join(dirname(dirname(getCodexConfigFile())), "codex-config.lock");
    return withSharedMutationLock(lock, operation, { waitMs: 300_000, reclaimStale: false });
}
