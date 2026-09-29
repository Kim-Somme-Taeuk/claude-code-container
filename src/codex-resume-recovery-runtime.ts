import { failedResumeRollout, missingResumeMetadata, migrationRepairedThread, supportsRolloutMigration } from "./codex-resume-diagnostics.js";
import { restoreResumeMetadata } from "./codex-resume-metadata.js";
import { terminalResumeCommand, type ResumeProcessRunner } from "./codex-resume-process.js";

export interface CodexResumeRecoveryPlan {
    command: string[];
    retry: string[];
    config: string[];
    selector?: string;
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
        let migration = await runner.run(
            [command[0], "migrate-rollouts", ...config, "--apply", "--thread", id, "--json"],
            { timeoutMs: 60000 },
        );
        if (runner.interrupted) return runner.interrupted;
        if (missingResumeMetadata(migration, id)) {
            const restored = await restoreResumeMetadata(command[0], config, rollout, home, runner);
            if (runner.interrupted) return runner.interrupted;
            if (!restored) {
                report("[ccc] Automatic session metadata repair did not complete; history was not deleted.\n");
                return first.code;
            }
            migration = await runner.run(
                [command[0], "migrate-rollouts", ...config, "--apply", "--thread", id, "--json"],
                { timeoutMs: 60000 },
            );
            if (runner.interrupted) return runner.interrupted;
        }
        const repaired = migration.code === 0 && !migration.signal && !migration.overflow
            && migrationRepairedThread(migration.output, id);
        if (!repaired) {
            report("[ccc] Automatic session repair did not complete; history was not deleted.\n");
            const diagnostic = migration.stderr || migration.output;
            if (diagnostic) report(diagnostic.slice(-2000) + "\n");
            return first.code;
        }
        return (await runner.run(terminalResumeCommand([...retry, id]), { terminal: true })).code;
    } finally {
        runner.dispose();
    }
}
