import type { RuntimeName } from "../domain/container-runtime.js";

export interface ContainerRuntimeReadinessPorts {
    isRunning(): boolean;
    runtimeInfo(): { runtime: RuntimeName; flavor: string };
    /** Select the reporter before rendering once synchronously; do not retain the supplier. */
    reportError(message: () => string): undefined;
    exitFailure(): undefined;
}
