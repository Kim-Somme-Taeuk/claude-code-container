import type { RuntimeName } from "./container-runtime.js";

/** Expected refusal: the running container cannot be joined or safely replaced. */
export class ContainerRestartRequiredError extends Error {
    constructor(
        readonly reason: string,
        readonly workspacePath: string,
        readonly runtime: RuntimeName,
        readonly profile?: string,
    ) {
        super(`Running container contract failed safety validation (${reason}); preserving the existing running container without joining it.`);
        this.name = "ContainerRestartRequiredError";
    }
}

/** Keep unexpected failures and explicitly requested debug stacks intact. */
export function formatContainerStartupError(error: unknown, debug = false): unknown {
    if (debug || !(error instanceof ContainerRestartRequiredError)) return error;
    return `[ccc] Container restart required: ${error.reason}.\n`
        + "Close the other CCC sessions for this workspace, then run "
        + `\`ccc --runtime ${error.runtime} stop\` from ${JSON.stringify(error.workspacePath)}.\n`
        + (error.profile ? `Keep CCC_PROFILE=${error.profile}, then retry your original command.` : "Then retry your original command.");
}
