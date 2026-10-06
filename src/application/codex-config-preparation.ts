import type { CodexConfigPreparationPorts } from "../ports/codex-config-preparation.js";

export function createCodexConfigPreparation(ports: CodexConfigPreparationPorts) {
    for (const name of ["probe", "repair", "finalize"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Codex config preparation requires a callable ${name} port.`);
        }
    }

    function run(target: string): undefined {
        const accessCheck = ports.probe(target);
        if (accessCheck.status === 0) return;
        if ((accessCheck.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
            || accessCheck.status === 124
            || accessCheck.status === 137) {
            throw new Error("Codex config access probe timed out");
        }
        if (accessCheck.error || (accessCheck.status !== 0 && accessCheck.status !== 1)) {
            throw new Error("Codex config access probe failed");
        }

        const repair = ports.repair(target);
        if ((repair.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
            || repair.status === 124
            || repair.status === 137) {
            throw new Error("Codex config repair timed out");
        }
        if (repair.error || repair.status !== 0) {
            throw new Error("Codex config repair failed");
        }

        const finalize = ports.finalize(target);
        if ((finalize.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
            || finalize.status === 124
            || finalize.status === 137) {
            throw new Error("Codex config repair timed out");
        }
        if (finalize.error || finalize.status !== 0) {
            throw new Error("Codex config repair failed");
        }
    }

    return { run };
}
