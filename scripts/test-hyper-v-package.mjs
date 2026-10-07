import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = new URL("../", import.meta.url);
const temporaryRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-"));

function run(executable, args, cwd = root) {
    if (process.platform === "win32" && args.some((arg) => arg.startsWith("test:level3:hyper-v"))) {
        throw new Error("package verification refuses a destructive Hyper-V host test on Windows");
    }
    const result = spawnSync(executable, args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || `${executable} exited ${result.status}`);
    }
    return result.stdout;
}

try {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm CLI path is unavailable for packaged Hyper-V probe");
    const packed = JSON.parse(run(process.execPath, [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot,
    ]));
    const filename = packed?.[0]?.filename;
    if (typeof filename !== "string" || !filename.endsWith(".tgz")) throw new Error("npm pack returned no archive");

    run("tar", ["-xzf", join(temporaryRoot, filename), "-C", temporaryRoot]);
    const packageRoot = join(temporaryRoot, "package");
    const consumerSource = join(temporaryRoot, "hyper-v-network-consumer.mts");
    const consumerConfig = join(temporaryRoot, "hyper-v-network-consumer.json");
    writeFileSync(consumerSource, [
        'import { createHyperVGuestDirectClient, createHyperVHostNetworkSpec, parseHyperVNatName, parseHyperVVirtualSwitchName, planHyperVVirtualMachineCreation, type HyperVConvertVHDRequest, type HyperVCreateVirtualMachineRequest, type HyperVGetVMDiagnosticRequest, type HyperVGuestDirectRequest, type HyperVGuestDirectResult, type HyperVHostNetworkReconciliationOutcome, type HyperVMountVHDRequest, type HyperVRemoveHostFilesRequest, type HyperVRemoveHostFilesResult, type HyperVRemoveVMGuard, type HyperVResizeVHDRequest, type HyperVVhdMutationCallOptions, type HyperVVirtualHardDisk, type HyperVWindowsClient } from "./package/dist/packages/hyper-v/dist/index.js";',
        'const network = createHyperVHostNetworkSpec({ switchName: parseHyperVVirtualSwitchName("consumer-switch"), natName: parseHyperVNatName("consumer-nat"), cidr: "172.29.0.0/24", gateway: "172.29.0.1" });',
        'function outcomeKind(outcome: HyperVHostNetworkReconciliationOutcome): string { switch (outcome.kind) { case "settled": case "conflict": case "needs-administrator": case "execute": case "indeterminate": return outcome.kind; } }',
        'function createVm(client: HyperVWindowsClient, request: HyperVCreateVirtualMachineRequest) {',
        '  const step = planHyperVVirtualMachineCreation(request).find((candidate) => candidate.kind === "create-vm");',
        '  if (!step || step.kind !== "create-vm") throw new Error("creation plan has no create-vm step");',
        '  return client.newVM({ name: step.vmName, generation: step.generation, memoryStartupBytes: step.memoryStartupBytes, vhdPath: step.vhdPath, ...(step.switchName === null ? {} : { switchName: step.switchName }) });',
        '}',
        'function inspectVhd(client: HyperVWindowsClient, path: string): Promise<HyperVVirtualHardDisk> { return client.getVHD(path); }',
        'function mountVhd(client: HyperVWindowsClient, request: HyperVMountVHDRequest): Promise<void> { return client.mountVHD(request); }',
        'function dismountVhd(client: HyperVWindowsClient, path: string): Promise<void> { return client.dismountVHD(path); }',
        'function convertVhd(client: HyperVWindowsClient, request: HyperVConvertVHDRequest, options: HyperVVhdMutationCallOptions): Promise<void> { return client.convertVHD(request, options); }',
        'function resizeVhd(client: HyperVWindowsClient, request: HyperVResizeVHDRequest, options: HyperVVhdMutationCallOptions): Promise<void> { return client.resizeVHD(request, options); }',
        'function vmStatus(client: HyperVWindowsClient, id: string) { return client.getVM({ kind: "id", id }); }',
        'function vmDiagnostic(client: HyperVWindowsClient, request: HyperVGetVMDiagnosticRequest) { return client.getVMDiagnostic(request); }',
        'function vmPower(client: HyperVWindowsClient, id: string, name: string, notes: string) { return client.restartVM({ selector: { kind: "id", id }, expectedName: name, expectedNotes: notes }); }',
        'function guardedRemove(client: HyperVWindowsClient, id: string, guard: HyperVRemoveVMGuard) { return client.removeVM({ selector: { kind: "id", id }, force: true, guard }); }',
        'function hostCleanup(client: HyperVWindowsClient, request: HyperVRemoveHostFilesRequest): Promise<HyperVRemoveHostFilesResult> { return client.removeHostFiles(request); }',
        'function guestDirect(client: ReturnType<typeof createHyperVGuestDirectClient>, request: HyperVGuestDirectRequest): Promise<HyperVGuestDirectResult> { return client.invoke(request, 1000); }',
        'void network; void outcomeKind; void createVm; void inspectVhd; void mountVhd; void dismountVhd; void convertVhd; void resizeVhd; void vmStatus; void vmDiagnostic; void vmPower; void guardedRemove; void hostCleanup; void guestDirect;',
    ].join("\n"), "utf8");
    writeFileSync(consumerConfig, JSON.stringify({
        compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            skipLibCheck: false,
        },
        files: [consumerSource],
    }), "utf8");
    run(process.execPath, [
        fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
        "-p",
        consumerConfig,
    ]);
    const compiledStandalone = join("dist", "real-tests", "hyper-v-windows-library.mjs");
    const compiledNetworkHost = join("dist", "real-tests", "hyper-v-windows-network-host.mjs");
    for (const relativePath of [
        compiledStandalone,
        compiledNetworkHost,
        join("dist", "real-tests", "hyper-v-windows-library-privileged.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library-command.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-network-command.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-real.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-host.test.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-fixture.ps1"),
        join("doc", "hyper-v-windows", "GUIDE__typed-library-support.md"),
    ]) {
        if (!existsSync(join(packageRoot, relativePath))) throw new Error(`packaged Hyper-V library real-test asset missing: ${relativePath}`);
    }
    const compiledStandaloneSource = readFileSync(join(packageRoot, compiledStandalone), "utf8");
    if (/import\s*\([^)]*\.ts["']\)/.test(compiledStandaloneSource)) {
        throw new Error("packaged Hyper-V library launcher retained a TypeScript runtime import");
    }
    const compiledNetworkHostSource = readFileSync(join(packageRoot, compiledNetworkHost), "utf8");
    if (/import\s*\([^)]*\.ts["']\)/.test(compiledNetworkHostSource)) {
        throw new Error("packaged Hyper-V network host proof retained a TypeScript runtime import");
    }
    const sourceCommand = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-command.mjs"), "utf8");
    const networkSourceCommand = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-network-command.mjs"), "utf8");
    const elevationHelper = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"), "utf8");
    const sourceHostSpec = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-host.test.ts"), "utf8");
    if (!sourceCommand.includes("run-vitest.mjs")
        || !sourceCommand.includes("CCC_HYPER_V_WINDOWS_LIBRARY_REAL")
        || !sourceCommand.includes("CCC_E2E_SKIP_BUILD")
        || !sourceCommand.includes("--library-fixture-only")
        || !sourceCommand.includes("tsconfig.hyper-v-windows.json")) {
        throw new Error("source Hyper-V library command does not dispatch to the opt-in Vitest spec");
    }
    if (!networkSourceCommand.includes("tsconfig.hyper-v-windows.json")
        || !networkSourceCommand.includes("hyper-v-windows-network-host.mjs")
        || !networkSourceCommand.includes("compiled entrypoint or host proof missing")) {
        throw new Error("source Hyper-V network command does not support checkout and packaged execution");
    }
    if (!sourceCommand.includes("requestAdministrator")
        || !elevationHelper.includes("-Verb RunAs")
        || !elevationHelper.includes("AssignProcessToJobObject")
        || !elevationHelper.includes("elevation-program-integrity-failed")
        || !sourceCommand.includes("hyper-v-windows-library-privileged.mjs")
        || !elevationHelper.includes("GLOBALROOT\\\\SystemRoot")) {
        throw new Error("packaged Hyper-V library command elevation boundary is incomplete");
    }
    if (!sourceHostSpec.includes('from "vitest"') || !sourceHostSpec.includes("runHyperVWindowsLibraryScenario")) {
        throw new Error("packaged Hyper-V library real-host Vitest spec is incomplete");
    }
    const packagedStandaloneModule = await import(pathToFileURL(join(packageRoot, compiledStandalone)).href);
    const packagedFixturePath = packagedStandaloneModule.verifiedHyperVWindowsLibraryFixturePath();
    const packagedFixtureOriginal = readFileSync(packagedFixturePath);
    writeFileSync(packagedFixturePath, Buffer.concat([packagedFixtureOriginal, Buffer.from("\n# tampered\n")]));
    let fixtureReplacementRejected = false;
    try {
        packagedStandaloneModule.verifiedHyperVWindowsLibraryFixturePath();
    } catch (error) {
        fixtureReplacementRejected = error instanceof Error
            && error.message === "hyper-v-library-fixture-asset-integrity-failed";
    }
    if (!fixtureReplacementRejected) throw new Error("replaced packaged Hyper-V fixture asset was accepted");
    writeFileSync(packagedFixturePath, packagedFixtureOriginal);

    const packagedLibrary = await import(pathToFileURL(join(packageRoot, "dist", "packages", "hyper-v", "dist", "index.js")).href);
    if (typeof packagedLibrary.createHyperVGuestDirectClient !== "function"
        || !["Get-VMDiagnostic", "Restart-VM", "Remove-VM", "Remove-HostFiles", "Invoke-Guest"]
            .every((operation) => packagedLibrary.HYPER_V_WINDOWS_OPERATIONS.includes(operation))) {
        throw new Error("packaged Hyper-V typed operations are incomplete");
    }
    const operationAsset = join(packageRoot, "dist", "packages", "hyper-v", "powershell", "Invoke-HyperVWindowsOperation.ps1");
    const operationOriginal = readFileSync(operationAsset);
    const operationExecutor = packagedLibrary.createHyperVWindowsPowerShellExecutor({
        executable: "unused-by-package-integrity-probe",
        run: () => ({ status: 0, stdout: '{"schemaVersion":1,"operation":"Get-VM","ok":true,"items":[]}' }),
    });
    await operationExecutor.execute({
        schemaVersion: 1,
        operation: "Get-VM",
        selector: { kind: "name", name: "package-integrity-probe" },
    }, { timeoutMilliseconds: 1000, maximumOutputBytes: 4096 });
    writeFileSync(operationAsset, Buffer.concat([operationOriginal, Buffer.from("\n# tampered\n")]));
    let operationReplacementRejected = false;
    try {
        await operationExecutor.execute({
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "name", name: "package-integrity-probe" },
        }, { timeoutMilliseconds: 1000, maximumOutputBytes: 4096 });
    } catch (error) {
        operationReplacementRejected = error instanceof Error
            && error.message === "hyper-v-windows-powershell-asset-integrity-failed";
    }
    if (!operationReplacementRejected) throw new Error("replaced packaged Hyper-V operation asset was accepted");
    writeFileSync(operationAsset, operationOriginal);
    if (process.platform !== "win32") {
        // On Windows this entrypoint requests UAC and mutates a disposable Hyper-V host.
        // Package verification must remain non-destructive on every platform.
        const packagedStandalone = run(process.execPath, [
            npmCli,
            "run",
            "test:level3:hyper-v:windows:library",
            "--ignore-scripts",
        ], packageRoot);
        if (!packagedStandalone.includes("SKIP level 3 Hyper-V Windows library real-host test: Windows host required")) {
            throw new Error("packaged Hyper-V library real-test entrypoint did not reach the host gate");
        }
        const packagedNetwork = run(process.execPath, [
            npmCli,
            "run",
            "test:level3:hyper-v:windows:network:library",
            "--ignore-scripts",
        ], packageRoot);
        if (!packagedNetwork.includes("SKIP Hyper-V Windows typed network real-host proof: Windows host required")) {
            throw new Error("packaged Hyper-V network real-test entrypoint did not use its prebuilt host proof");
        }
    }
    const resolverUrl = pathToFileURL(join(packageRoot, "dist", "packages", "device-lab", "dist", "host-control", "hyper-v", "powershell-assets.js"));
    const { hyperVPowerShellAssetPath } = await import(resolverUrl.href);

    // "snapshot-create" left the manifest when the typed library took over checkpoints; the
    // resolver throws on an unknown operation, so a stale entry here aborts the whole loop.
    for (const operation of ["linux-bootstrap-network", "guest-boot-diagnostic", "snapshot-repair"]) {
        const asset = hyperVPowerShellAssetPath(operation);
        if (!existsSync(asset)) throw new Error(`packaged Hyper-V asset missing: ${operation}`);
        if (relative(packageRoot, asset).startsWith("..")) throw new Error(`packaged Hyper-V asset escaped package: ${operation}`);
        if (!readFileSync(asset, "utf8").includes("Read-CccJsonContract")) {
            throw new Error(`packaged Hyper-V asset contract missing: ${operation}`);
        }
    }

    const coreModule = join(packageRoot, "dist", "packages", "device-lab", "powershell", "Ccc.HyperV.Core.psm1");
    const replacement = `${coreModule}.replacement`;
    writeFileSync(replacement, `${readFileSync(coreModule, "utf8")}\n# replaced after verification\n`);
    renameSync(replacement, coreModule);
    let replacementRejected = false;
    try {
        hyperVPowerShellAssetPath("linux-bootstrap-network");
    } catch (error) {
        replacementRejected = error instanceof Error && error.message === "hyper-v-powershell-asset-integrity-failed";
    }
    if (!replacementRejected) throw new Error("replaced packaged Hyper-V asset was accepted");
    process.stdout.write("PASS packaged Hyper-V PowerShell assets and standalone library entrypoints\n");
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}
