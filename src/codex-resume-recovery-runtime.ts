import { failedResumeRollout, missingResumeMetadata, migrationRepairedThread, supportsRolloutMigration } from "./codex-resume-diagnostics.js";
import { restoreResumeMetadata, type ResumeMetadataFailureStage } from "./codex-resume-metadata.js";
import { terminalResumeCommand, type ResumeProcessRunner } from "./codex-resume-process.js";

export interface CodexResumeRecoveryPlan {
    command: string[];
    retry: string[];
    config: string[];
    selector?: string;
}

type ResumeFailureStage = ResumeMetadataFailureStage | "migration" | "migration-after-metadata";

const FAILURE_EXPLANATIONS: Record<ResumeFailureStage, string> = {
    "metadata-support": "Codex metadata recovery is unavailable",
    "metadata-home": "Could not verify the Codex data directory",
    "metadata-initialize": "Could not verify the metadata server",
    "metadata-read": "Could not restore this session's metadata",
    "metadata-close": "The metadata server did not finish cleanly",
    "migration": "Session migration failed",
    "migration-after-metadata": "Session migration failed after metadata recovery",
};

function failureMessage(stage: ResumeFailureStage): string {
    return `[ccc] ${FAILURE_EXPLANATIONS[stage]} (${stage}).\n`;
}

/** Run one original launch, at most one native scoped repair, and at most one retry. */
export async function runCodexResumeRecovery(
    plan: CodexResumeRecoveryPlan,
    runner: ResumeProcessRunner,
    home: string,
    report: (message: string) => void,
): Promise<number> {
    const { command, retry, config, selector } = plan;
    try {
        const script = await runner.run(["/usr/bin/script", "--version"], { timeoutMs: 5000 });
        if (runner.interrupted) return runner.interrupted;
        if (script.code !== 0 || !script.output.includes("util-linux")) {
            return (await runner.run(command, { direct: true })).code;
        }
        const first = await runner.run(terminalResumeCommand(command), { terminal: true });
        if (runner.interrupted) return runner.interrupted;
        if (first.code !== 1 || first.signal) return first.code;
        const rollout = failedResumeRollout(first.output, home, selector);
        if (!rollout) return first.code;
        const { id } = rollout;
        const help = await runner.run([command[0], "migrate-rollouts", "--help"], { timeoutMs: 5000 });
        if (runner.interrupted) return runner.interrupted;
        if (!supportsRolloutMigration(help)) return first.code;
        report("[ccc] Repairing this session's history index and resuming once.\n");
        let migrationStage: "migration" | "migration-after-metadata" = "migration";
        let migration = await runner.run(
            [command[0], "migrate-rollouts", ...config, "--apply", "--thread", id, "--json"],
            { timeoutMs: 60000 },
        );
        if (runner.interrupted) return runner.interrupted;
        if (missingResumeMetadata(migration, id)) {
            const restored = await restoreResumeMetadata(command[0], config, rollout, home, runner);
            if (runner.interrupted) return runner.interrupted;
            if (!restored.ok) {
                report(failureMessage(restored.stage));
                return first.code;
            }
            migrationStage = "migration-after-metadata";
            migration = await runner.run(
                [command[0], "migrate-rollouts", ...config, "--apply", "--thread", id, "--json"],
                { timeoutMs: 60000 },
            );
            if (runner.interrupted) return runner.interrupted;
        }
        const repaired = migration.code === 0 && !migration.signal && !migration.overflow
            && migrationRepairedThread(migration.output, id);
        if (!repaired) {
            report(failureMessage(migrationStage));
            return first.code;
        }
        return (await runner.run(terminalResumeCommand([...retry, id]), { terminal: true })).code;
    } finally {
        runner.dispose();
    }
}
