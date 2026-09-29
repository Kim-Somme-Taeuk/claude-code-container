import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { missingBrokerCapabilities } from "../../../device-lab-mcp/src/contracts/broker-capabilities.mjs";

export const HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT = "hyper-v-windows-unattend-oobe-schema-v3";
export const HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT = "hyper-v-powershell-direct-bounded-probe-v1";
export const HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT = "hyper-v-windows-library-v17";
// Every contract that is also exported standalone is declared above the required list and then
// referenced by it, never re-spelled inside it. Two reasons: the array is evaluated at module load,
// so a forward reference hits the temporal dead zone; and a duplicated literal is free to drift, so
// the exported contract and the entry attestation actually checks can silently disagree.
export const HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT = "hyper-v-guest-readiness-diagnostics-v24";
export const HYPER_V_LEVEL3_PROVIDER_CONTRACT = "hyper-v-provider-image-finalization-v40";
export const HYPER_V_LEVEL3_LINUX_X11_TYPE_CONTRACT = "hyper-v-linux-x11-type-v2";
export const HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT = "hyper-v-setup-network-v11";
export const HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT = "hyper-v-network-failure-diagnostics-v11";
export const HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES = [
    "hyper-v-vm-managed-auto-images-v20",
    HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT,
    HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT,
    "hyper-v-windows-boot-contract-v1",
    HYPER_V_LEVEL3_WINDOWS_LIBRARY_CONTRACT,
    HYPER_V_LEVEL3_WINDOWS_UNATTEND_OOBE_SCHEMA_CONTRACT,
    HYPER_V_LEVEL3_POWERSHELL_DIRECT_BOUNDED_PROBE_CONTRACT,
    "hyper-v-linux-create-response-v1",
    "hyper-v-image-acquisition-stage-cache-v1",
    "hyper-v-powershell-stage-propagation-v1",
    HYPER_V_LEVEL3_PROVIDER_CONTRACT,
    HYPER_V_LEVEL3_LINUX_X11_TYPE_CONTRACT,
    HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT,
];
const HOST_BROKER_STATUS_MAX_BYTES = 256 * 1024;
const HOST_BROKER_STATUS_TIMEOUT_MS = 5000;
const HOST_BROKER_REPAIR_TIMEOUT_MS = 180000;
const HOST_BROKER_ATTESTATION_MAX_ATTEMPTS = 3;
// The broker's /status reports its elevation gate: whether this broker process already had a UAC
// prompt declined or left unanswered, after which it never asks again. Only the closed state, a code
// from the elevation family and an ISO instant are echoed, so a malformed status cannot put
// arbitrary text into the Level 3 log.
const HOST_BROKER_ELEVATION_GATE_CODE = /^hyper-v-network-elevation-[a-z0-9-]{1,64}$/;
const HOST_BROKER_ELEVATION_GATE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function hostBrokerElevationGate(value: any) {
    // A broker from before the gate existed has no field. The capabilities Level 3 requires shipped
    // with the gate, so only an in-between development build lacks it: reported, not failed.
    if (value === undefined) return { state: "unreported" };
    if (value?.state === "never-asked") return { state: "never-asked" };
    if (value?.state !== "refused") return { state: "unrecognized" };
    return {
        state: "refused",
        code: typeof value.code === "string" && HOST_BROKER_ELEVATION_GATE_CODE.test(value.code)
            ? value.code
            : "invalid",
        at: typeof value.at === "string" && HOST_BROKER_ELEVATION_GATE_INSTANT.test(value.at)
            && Number.isFinite(Date.parse(value.at))
            ? value.at
            : "invalid",
    };
}

export function buildLevel3Artifacts(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const readFile = options.readFile || readFileSync;
    const writeFile = options.writeFile || writeFileSync;
    const env = options.env || process.env;
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const compiled = spawn(process.execPath, [tsc], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (compiled.status !== 0) {
        process.stderr.write(compiled.stderr || compiled.stdout || "CCC host broker build failed\n");
        return compiled.status ?? 1;
    }
    const builtHyperVProvider = join(repoRoot, "dist", "host-control", "hyper-v", "contracts.js");
    const providerArtifact = readFile(builtHyperVProvider, "utf-8");
    if (!providerArtifact.includes(HYPER_V_LEVEL3_PROVIDER_CONTRACT)) {
        process.stderr.write(`Hyper-V provider build attestation failed; missing ${HYPER_V_LEVEL3_PROVIDER_CONTRACT} in ${builtHyperVProvider}\n`);
        return 1;
    }
    const realTestsTypecheck = spawn(process.execPath, [tsc, "-p", join(repoRoot, "tsconfig.real-tests.json")], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (realTestsTypecheck.status !== 0) {
        process.stderr.write(realTestsTypecheck.stderr || realTestsTypecheck.stdout || "Level 3 real-test typecheck failed\n");
        return realTestsTypecheck.status ?? 1;
    }
    const packageVersion = JSON.parse(readFile(join(repoRoot, "package.json"), "utf-8")).version;
    const builtUtils = join(repoRoot, "dist", "utils.js");
    writeFile(builtUtils, readFile(builtUtils, "utf-8").replace("__CLI_VERSION__", packageVersion));
    const esbuild = join(repoRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
    const bundled = spawn(process.execPath, [esbuild, "device-lab-mcp/server.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=dist/device-lab-mcp/server.mjs", "--banner:js=// device-lab-mcp-version: 1"], {
        cwd: repoRoot, env, encoding: "utf-8", windowsHide: true,
    });
    if (bundled.status !== 0) {
        process.stderr.write(bundled.stderr || bundled.stdout || "device-lab MCP build failed\n");
        return bundled.status ?? 1;
    }
    // The elevated half of the Windows Setup diagnostic. requestAdministrator runs a single
    // digest-verified program, so this has to be one file; it is built here rather than lazily at
    // failure time because a bundler running inside an already-failing diagnostic would turn a
    // missing privilege into a build error, and the operator would be reading the wrong problem.
    //
    // Windows hosts only. buildLevel3Artifacts is the shared entry — level3.ts calls it too — so
    // building unconditionally meant every Linux Level 3 run bundled a Windows-only program that
    // pulls in the whole src/host-control/hyper-v barrel, and a failure there would have failed
    // runs that can never use it. The elevation request is gated on win32 anyway, so off Windows
    // the bundle has no reader.
    if ((options.platform || process.platform) !== "win32") return 0;
    const privileged = spawn(process.execPath, [
        esbuild,
        "scripts/real-tests/hyper-v-windows-setup-diagnostics-privileged.ts",
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--outfile=dist/real-tests/hyper-v-windows-setup-diagnostics-privileged.mjs",
    ], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (privileged.status === 0) return 0;
    process.stderr.write(privileged.stderr || privileged.stdout || "Hyper-V Windows setup-diagnostics privileged bundle failed\n");
    return privileged.status ?? 1;
}

export async function probeHostBrokerCapabilities(port: number, options: any = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || HOST_BROKER_STATUS_TIMEOUT_MS);
    try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/status`, {
            signal: controller.signal,
            redirect: "manual",
        });
        if (!response.ok || (response.status >= 300 && response.status < 400)) {
            return { ok: false, error: `http-${response.status}`, capabilities: [] };
        }
        const declaredLength = response.headers?.get?.("content-length");
        if (declaredLength && /^\d+$/.test(declaredLength)
            && Number(declaredLength) > HOST_BROKER_STATUS_MAX_BYTES) {
            return { ok: false, error: "response-too-large", capabilities: [] };
        }
        if (!response.body || typeof response.body.getReader !== "function") {
            return { ok: false, error: "missing-response-body", capabilities: [] };
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                receivedBytes += value.byteLength;
                if (receivedBytes > HOST_BROKER_STATUS_MAX_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    return { ok: false, error: "response-too-large", capabilities: [] };
                }
                chunks.push(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
        }
        const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
        const parsed = JSON.parse(text);
        const implemented = parsed?.ok === true && parsed?.broker && Array.isArray(parsed.broker.implemented)
            ? parsed.broker.implemented.map(String)
            : [];
        const pid = Number(parsed?.broker?.process?.pid);
        const startedAt = typeof parsed?.broker?.startedAt === "string" ? parsed.broker.startedAt : "";
        return implemented.length > 0 && Number.isInteger(pid) && pid > 0 && startedAt
            ? {
                ok: true,
                capabilities: implemented,
                pid,
                startedAt,
                elevationGate: hostBrokerElevationGate(parsed.broker.hyperVElevationGate),
            }
            : { ok: false, error: "invalid-status-response", capabilities: [] };
    } catch (error: any) {
        return { ok: false, error: error?.name === "AbortError" ? "timeout" : "fetch-failed", capabilities: [] };
    } finally {
        clearTimeout(timer);
    }
}

export async function ensureHostBrokerReady(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const repairTimeoutMs = Number.isFinite(options.repairTimeoutMs)
        ? Math.max(1, Number(options.repairTimeoutMs))
        : HOST_BROKER_REPAIR_TIMEOUT_MS;
    const deadlineAt = Date.now() + repairTimeoutMs;
    const remainingMs = () => Math.max(1, deadlineAt - Date.now());
    const runStatus = () => spawn(
        process.execPath,
        [join(repoRoot, "dist", "index.js"), "devices", "broker", "status", "--verbose"],
        {
            cwd: repoRoot,
            env: options.env || process.env,
            encoding: "utf-8",
            timeout: remainingMs(),
            maxBuffer: HOST_BROKER_STATUS_MAX_BYTES,
            windowsHide: true,
        },
    );
    for (let attempt = 1; attempt <= HOST_BROKER_ATTESTATION_MAX_ATTEMPTS; attempt += 1) {
        const result = runStatus();
        const stdout = String(result.stdout || "");
        const verifiedCapabilities = /^brokerVerifiedCapabilities:\s*(.*)$/m.exec(stdout)?.[1]
            ?.split(",")
            .map((capability) => capability.trim())
            .filter(Boolean) || [];
        // Same family-versioned rule as the CLI whose reuse decision this attests: a newer -vM
        // satisfies -vN, an older one does not.
        const missingCapabilities = missingBrokerCapabilities(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES, verifiedCapabilities);
        const verifiedPid = Number(/^brokerVerifiedPid:\s*(\d+)$/m.exec(stdout)?.[1] || "");
        const verifiedStartedAt = /^brokerVerifiedStartedAt:\s*(\S+)$/m.exec(stdout)?.[1] || "";
        if (result.status === 0 && missingCapabilities.length > 0) {
            process.stderr.write(`CCC host broker capability attestation failed; missing: ${missingCapabilities.join(", ")}\n`);
            return 1;
        }
        if (result.status !== 0 || !/brokerReady:\s*true/.test(stdout)) {
            const processError = result.error instanceof Error
                ? `${result.error.name}: ${result.error.message}`
                : result.error ? String(result.error) : "";
            const childOutput = String(result.stderr || result.stdout || "").trimEnd();
            const processDiagnostic = [
                "CCC host broker repair preflight failed",
                `status=${result.status ?? "missing"}`,
                `signal=${result.signal || "none"}`,
                `error=${processError || "no-output"}`,
                `timeoutMs=${repairTimeoutMs}`,
            ].join("; ");
            process.stderr.write(`${childOutput ? `${childOutput}\n` : ""}${processDiagnostic}\n`);
            return 1;
        }
        if (!Number.isInteger(verifiedPid) || verifiedPid < 1 || !verifiedStartedAt) {
            process.stderr.write("CCC host broker capability attestation failed; status did not report a valid process identity\n");
            return 1;
        }
        const port = Number(/^port:\s*(\d+)$/m.exec(stdout)?.[1] || "");
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            process.stderr.write("CCC host broker capability attestation failed; status did not report a valid port\n");
            return 1;
        }
        const probe = options.probeHostBrokerCapabilitiesImpl || probeHostBrokerCapabilities;
        const observed = await probe(port, {
            ...options,
            timeoutMs: Math.min(
                remainingMs(),
                Number.isFinite(options.timeoutMs)
                    ? Math.max(1, Number(options.timeoutMs))
                    : HOST_BROKER_STATUS_TIMEOUT_MS,
            ),
        });
        const observedCapabilities = Array.isArray(observed?.capabilities)
            ? observed.capabilities.map(String)
            : [];
        const missingObservedCapabilities = missingBrokerCapabilities(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES, observedCapabilities);
        if (observed?.ok !== true || missingObservedCapabilities.length > 0) {
            process.stderr.write([
                "CCC host broker remote capability attestation failed",
                `port=${port}`,
                `error=${String(observed?.error || "missing-required-capabilities")}`,
                `missing=${missingObservedCapabilities.join(", ") || "unknown"}`,
                `observed=${observedCapabilities.filter((capability) => capability.startsWith("hyper-v-")).join(", ") || "none"}`,
            ].join("; ") + "\n");
            return 1;
        }
        if (!Number.isInteger(observed.pid) || observed.pid < 1 || !observed.startedAt) {
            process.stderr.write("CCC host broker remote capability attestation failed; invalid process identity\n");
            return 1;
        }
        const confirmed = await probe(port, {
            ...options,
            timeoutMs: Math.min(
                remainingMs(),
                Number.isFinite(options.timeoutMs)
                    ? Math.max(1, Number(options.timeoutMs))
                    : HOST_BROKER_STATUS_TIMEOUT_MS,
            ),
        });
        const confirmedCapabilities = Array.isArray(confirmed?.capabilities)
            ? confirmed.capabilities.map(String)
            : [];
        const missingConfirmedCapabilities = missingBrokerCapabilities(HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES, confirmedCapabilities);
        if (confirmed?.ok !== true || missingConfirmedCapabilities.length > 0) {
            process.stderr.write([
                "CCC host broker remote confirmation attestation failed",
                `port=${port}`,
                `error=${String(confirmed?.error || "missing-required-capabilities")}`,
                `missing=${missingConfirmedCapabilities.join(", ") || "unknown"}`,
                `observed=${confirmedCapabilities.filter((capability) => capability.startsWith("hyper-v-")).join(", ") || "none"}`,
            ].join("; ") + "\n");
            return 1;
        }
        if (!Number.isInteger(confirmed.pid) || confirmed.pid < 1 || !confirmed.startedAt) {
            process.stderr.write("CCC host broker remote confirmation attestation failed; invalid process identity\n");
            return 1;
        }
        if (verifiedPid === observed.pid
            && confirmed.pid === observed.pid
            && verifiedStartedAt === observed.startedAt
            && confirmed.startedAt === observed.startedAt) {
            process.stdout.write(`ATTEST Hyper-V broker pid=${observed.pid} startedAt=${observed.startedAt}\n`);
            // The gate belongs to the process just attested, and within one process it only moves
            // from never-asked to refused, so the confirmation read is the latest word on it. A
            // refused gate outlives the run that caused it: every Hyper-V step that needs
            // Administrator would fail hours in with hyper-v-network-elevation-suppressed, so the
            // run stops here instead, with the remedy. This preflight gates the whole run, so a
            // Level 3 run starts none of its other providers either.
            const gate = confirmed.elevationGate || { state: "unreported" };
            if (gate.state === "refused") {
                process.stderr.write([
                    `CCC host broker Hyper-V elevation gate refused; pid=${observed.pid}; code=${gate.code}; at=${gate.at}`,
                    "Run not started, including any non-Hyper-V Level 3 steps: this broker already had a UAC prompt declined or left unanswered and will not ask again, so every Hyper-V step that needs Administrator would fail with hyper-v-network-elevation-suppressed.",
                    `Remedy: restart the broker to clear the refusal. Stop process ${observed.pid}; the next Level 3 run or 'ccc devices broker status' starts a fresh one.`,
                    "If nobody will be there to approve a prompt, first run an attended 'ccc devices setup hyper-v --confirm' so the CCC Hyper-V network exists and the run needs none.",
                ].join("\n") + "\n");
                return 1;
            }
            process.stdout.write(`ATTEST Hyper-V elevation gate state=${String(gate.state)}\n`);
            return 0;
        }
        const canRetry = attempt < HOST_BROKER_ATTESTATION_MAX_ATTEMPTS && Date.now() < deadlineAt;
        if (canRetry) continue;
        process.stderr.write([
            "CCC host broker process identity changed during capability attestation",
            `attempts=${attempt}`,
            `port=${port}`,
            `initialPid=${verifiedPid}`,
            `observedPid=${observed.pid}`,
            `confirmedPid=${confirmed.pid}`,
        ].join("; ") + "\n");
        return 1;
    }
    return 1;
}
