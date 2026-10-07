import assert from "assert";
import { deviceLabSmoke } from "../../dist/device-lab-admin.js";
import { commandPath } from "./helpers.ts";
import { markExpectedInputError, parseToolPayload, parseToolResult, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { aggregateStepResult } from "./result-status.ts";

const lifecycleCommandPattern = /\b(start|run|launch|boot|delete|stop|shutdown)\b/i;
const expectedBackends = [
    { backend: "android-emulator", label: "Android emulator readiness" },
    { backend: "android-device", label: "Android physical device readiness" },
    { backend: "ios-simulator", label: "iOS Simulator readiness" },
    { backend: "ios-device", label: "iOS physical device readiness" },
    { backend: "windows-sandbox", label: "Windows Sandbox readiness" },
    { backend: "windows-vm", label: "Hyper-V Windows VM readiness" },
    { backend: "linux-vm", label: "Hyper-V Linux VM readiness" },
    { backend: "macos-vm", label: "macOS VM readiness" },
];

export const name = "level 1 real-provider readiness";

function commandArgsText(command) {
    const firstSpace = command.indexOf(" ");
    return firstSpace === -1 ? "" : command.slice(firstSpace + 1);
}

export async function runRealProviderReadiness(options: any = {}) {
    const smoke = deviceLabSmoke(process.cwd(), 5000, undefined, { mode: "real-provider" });
    assert.strictEqual(smoke.mode, "real-provider");
    assert.deepStrictEqual(smoke.results.map((result) => result.backend).sort(), expectedBackends.map((item) => item.backend).sort());
    const steps = expectedBackends.map((item) => {
        const result = smoke.results.find((candidate) => candidate.backend === item.backend);
        if (!result) return { name: item.label, status: "FAIL", reason: "missing readiness result" };
        if (result.status === "SKIP") return { name: item.label, status: "SKIP", reason: result.detail };
        if (result.status === "FAIL") return { name: item.label, status: "FAIL", reason: result.detail };
        for (const command of result.commands || []) {
            assert.strictEqual(lifecycleCommandPattern.test(commandArgsText(command.command)), false, command.command);
        }
        return { name: item.label, status: "PASS" };
    });

    await withDeviceLabMcp(async ({ callTool }) => {
        const androidWirelessResult = await callTool("wireless", { detail: true,
            backend: "android-device",
            action: "status",
            timeoutMs: 5000,
        });
        const androidWireless = parseToolResult(androidWirelessResult, { expectedError: androidWirelessResult?.isError === true });
        if (androidWireless.ok === true) {
            assert.strictEqual(androidWireless.ok, true, JSON.stringify(androidWireless));
            assert.strictEqual(androidWireless.provider, "adb", JSON.stringify(androidWireless));
            steps.push({ name: "Android physical wireless status MCP", status: "PASS" });

        } else {
            assert.strictEqual(androidWireless.error, "android-wireless-missing-adb", JSON.stringify(androidWireless));
            assert.deepStrictEqual(androidWireless.missing, ["adb"], JSON.stringify(androidWireless));
            steps.push({ name: "Android physical wireless status MCP", status: "SKIP", reason: "missing adb" });
        }
        for (const [action, error] of [
            ["usb-tcpip", "wireless usb-tcpip requires serial"],
            ["pair", "wireless pair requires pairHost, pairPort and pairingCode"],
            ["connect", "wireless connect requires host or serial"],
        ]) {
            const result = await callTool("wireless", {
                detail: true, backend: "android-device", action, timeoutMs: 5000,
            });
            const diagnostic = parseToolResult(markExpectedInputError(result, error), { expectedError: true });
            assert.strictEqual(diagnostic.ok, false, JSON.stringify(diagnostic));
        }
        steps.push({ name: "Android physical wireless action diagnostics MCP", status: "PASS" });

        if (process.platform === "darwin" && commandPath("xcrun")) {
            const iosWireless = parseToolPayload(await callTool("wireless", { detail: true,
                backend: "ios-device",
                action: "status",
            }));
            assert.strictEqual(iosWireless.ok, true, JSON.stringify(iosWireless));
            assert.strictEqual(iosWireless.provider, "xcrun-xctrace", JSON.stringify(iosWireless));
            steps.push({ name: "iOS physical wireless status MCP", status: "PASS" });
        } else {
            steps.push({
                name: "iOS physical wireless status MCP",
                status: "SKIP",
                reason: process.platform === "darwin" ? "missing xcrun" : "not a macOS host",
            });
        }

        for (const action of ["pair", "connect"]) {
            const result = await callTool("wireless", { detail: true,
                backend: "ios-device",
                action,
            });
            const iosWirelessDiagnostic = parseToolResult(markExpectedInputError(
                result, "iOS wireless supports only action:status",
            ), { expectedError: true });
            assert.strictEqual(iosWirelessDiagnostic.ok, false, JSON.stringify(iosWirelessDiagnostic));
        }
        steps.push({ name: "iOS physical wireless action diagnostics MCP", status: "PASS" });
    }, providerMcpSessionOptions(options, "ccc-real-provider-readiness"));

    return { ...aggregateStepResult(steps), steps };
}

export async function run() {
    return runRealProviderReadiness();
}
