import { runWithTimeout } from "../commands.mjs";
import { createWaitBudget } from "../wait-budget.mjs";

function commandFailed(result) {
    return result.status !== 0 || Boolean(result.error || result.signal);
}

function waitFailure(result) {
    const cause = result.error?.message || (result.signal ? `signal ${result.signal}` : "");
    return { error: cause ? { ...result, stderr: `${cause}${result.stderr ? `: ${result.stderr}` : ""}` } : result };
}

function androidWait(adb, targetArgs, timeoutMs, intervalMs) {
    const wait = createWaitBudget(timeoutMs, intervalMs);
    return {
        ...wait,
        run(args) {
            const budget = wait.requestTimeout();
            if (budget <= 0) return { status: null, stderr: "Android wait deadline exhausted before completing the observation" };
            return runWithTimeout(adb, [...targetArgs, ...args], budget);
        },
    };
}

export async function waitForAndroidText(adb, targetArgs, remotePath, text, timeoutMs, intervalMs) {
    const wait = androidWait(adb, targetArgs, timeoutMs, intervalMs);
    let last = waitFailure({ status: null, stderr: "Android wait deadline exhausted before observing UI" });
    while (wait.remaining() > 0) {
        const dump = wait.run(["shell", "uiautomator", "dump", remotePath]);
        if (commandFailed(dump)) {
            last = waitFailure(dump);
        } else {
            let read = wait.run(["exec-out", "cat", remotePath]);
            if (commandFailed(read) && wait.remaining() > 0) {
                read = wait.run(["shell", "cat", remotePath]);
            }
            if (commandFailed(read)) {
                last = waitFailure(read);
            } else {
                last = { found: false, source: read.stdout, timeoutMs: wait.timeoutMs };
                if (read.stdout.includes(text)) return { found: true, source: read.stdout, remotePath };
            }
        }
        await wait.pause();
    }
    return last;
}

export async function waitForAndroidApp(adb, targetArgs, packageName, timeoutMs, intervalMs) {
    const wait = androidWait(adb, targetArgs, timeoutMs, intervalMs);
    let last = waitFailure({ status: null, stderr: "Android wait deadline exhausted before observing the app" });
    while (wait.remaining() > 0) {
        const result = wait.run(["shell", "pidof", packageName]);
        const absent = result.status === 1 && !result.stdout && !result.stderr && !result.error && !result.signal;
        if (commandFailed(result) && !absent) {
            last = waitFailure(result);
        } else {
            const pid = result.stdout.trim();
            if (pid) return { running: true, pid, stdout: result.stdout, stderr: result.stderr, status: result.status };
            last = { running: false, timeoutMs: wait.timeoutMs, stdout: result.stdout, stderr: result.stderr, status: 0, nativeStatus: result.status };
        }
        await wait.pause();
    }
    return last;
}
