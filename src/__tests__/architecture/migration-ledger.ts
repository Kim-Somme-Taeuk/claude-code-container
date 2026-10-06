/** Checked source inventory, not an audit certificate or migration receipt. */
export interface SourceAnchor { path: string; exports: readonly string[]; }
export interface MigrationPacket {
    id: string;
    status: "partial" | "in-progress" | "pending/legacy";
    dependsOn: readonly string[];
    sources: readonly SourceAnchor[];
    tests: readonly string[];
    nativeLanes: readonly string[];
}
const anchor = (path: string, ...exports: string[]): SourceAnchor => ({ path, exports });
const packet = (id: string, dependsOn: string[], sources: SourceAnchor[], tests: string[], nativeLanes: string[]): MigrationPacket => ({
    id, status: id === "M00" ? "partial" : id === "M01" ? "in-progress" : "pending/legacy",
    dependsOn, sources, tests, nativeLanes,
});
const test = (name: string) => `src/__tests__/${name}.test.ts`;

export const migrationProvenance = {
    baselineCommit: "2c90a3315536abef14c9c2737bb1e8742f129f25",
    source: { kind: "candidate-worktree", evidence: "Static anchors checked against the candidate; readiness foundation includes uncommitted changes." },
    artifact: { kind: "unverified", evidence: "No built artifact hash or installed-package result is asserted by this ledger." },
    native: { kind: "unrun", evidence: "Historical host runs do not certify this candidate. Each cutover must record its own native evidence." },
    cutoverRequirement: "Before each operation cutover inventory exact symbols, callers, exports, persistent files, nested lock acquisition/process ownership, authority and tests; these anchors are not exhaustive.",
} as const;

export const migrationPackets: readonly MigrationPacket[] = [
    packet("M00", [], [anchor("doc/common/ADR__ccc-target-architecture.md"), anchor("doc/common/SPEC__ccc-architecture-contracts.md"), anchor("doc/common/PLAN__ccc-architecture-migration.md")], [test("architecture/migration-ledger")], ["none: source inventory only"]),
    packet("M01", ["M00"], [anchor("packages/device-lab/providers/application/start-readiness.mjs", "waitForStartReadiness"), anchor("device-lab-mcp/src/start-readiness.mjs", "finishStartReadiness")], [test("device-lab-application-readiness"), test("device-lab-start-readiness")], ["portable core; native readiness not newly certified"]),
    packet("M02", ["M01"], [anchor("packages/device-lab/src/device-lab-state-file.ts", "readDeviceLabStateFile"), anchor("packages/device-lab/src/device-lab-owner.ts", "deviceLabOwnerId"), anchor("packages/device-lab/providers/state/device-operation-policy.mjs", "requiresOwnerDeviceOperation")], [test("device-lab-owner-state-validation"), test("device-lab-state-crash-recovery")], ["Windows/Unix filesystem and process identity; two-process contention"]),
    packet("M03", ["M02"], [anchor("device-lab-mcp/src/server.mjs"), anchor("device-lab-mcp/src/broker.mjs"), anchor("packages/device-lab/src/device-lab-broker.ts", "DEVICE_BROKER_RPC_BODY_LIMIT")], [test("device-lab-mcp.broker-routing"), test("device-lab-mcp.owner-context")], ["direct/broker/child contract lanes; no implicit device discovery"]),
    packet("M04", ["M03"], [anchor("packages/device-lab/providers/backends/windows-sandbox.mjs", "windowsBackend"), anchor("packages/device-lab/providers/backends/windows-helper.ps1")], [test("device-lab-mcp.windows"), "scripts/real-tests/windows-sandbox-e2e.test.ts"], ["Windows Sandbox disposable instance with actual control proof"]),
    packet("M05", ["M02", "M04"], [anchor("packages/device-lab/src/device-lab/broker/hyper-v/power.ts"), anchor("packages/hyper-v/src/lifecycle/index.ts"), anchor("packages/hyper-v/src/low-level/index.ts")], [test("hyper-v-windows-vm-create-lifecycle"), test("hyper-v-windows-low-level")], ["Windows Hyper-V host; disposable Windows and Linux guests"]),
    packet("M06", ["M05"], [anchor("src/device-lab-admin.ts", "cleanupOwnerDevices"), anchor("packages/device-lab/providers/backends/linux-vm.mjs")], [test("device-lab-admin.cleanup"), test("device-lab-admin.prune")], ["Hyper-V image/network host; container-QEMU image lane"]),
    packet("M07", ["M03"], [anchor("packages/device-lab/providers/backends/android.mjs", "handleAndroidTool"), anchor("packages/device-lab/providers/backends/ios-device.mjs")], [test("device-lab-broker.leases"), test("device-lab-broker.appium")], ["explicitly authorized Android/iOS hardware; recording/Appium lifecycle"]),
    packet("M08", ["M07"], [anchor("packages/device-lab/providers/backends/macos-vm.mjs"), anchor("packages/device-lab/providers/backends/linux-vm.mjs"), anchor("packages/device-lab/providers/backends/android.mjs", "androidBackend")], [test("device-lab-mcp.android-emulator"), test("device-lab-mcp.ios-simulator"), test("device-lab-mcp.macos"), test("device-lab-mcp.linux-vm-provider")], ["Android emulator", "macOS simulator/VM", "Linux container-QEMU/X11"]),
    packet("M09", ["M06", "M08"], [anchor("packages/device-lab/src/broker-entry.ts"), anchor("packages/device-lab/src/device-lab-broker.ts"), anchor("device-lab-mcp/src/server.mjs")], [test("device-lab-broker-call-flow"), test("device-lab-mcp.definitions")], ["installed stdio/broker contracts; affected provider native lanes"]),
    packet("M10", ["M01"], [anchor("src/docker.ts", "startProjectContainer"), anchor("src/session.ts", "withContainerLifecycleLock"), anchor("src/container-runtime.ts", "runtimeExtraRunArgs")], [test("docker"), test("container-runtime"), test("session")], ["Linux Docker/Podman", "Windows/macOS remote container runtime" ]),
    packet("M11", ["M10"], [anchor("src/worktree.ts", "createWorkspace", "removeWorkspace"), anchor("src/tool-registry.ts", "getAllCredentialMounts"), anchor("src/profile.ts", "createProfile"), anchor("src/docker.ts", "sshCredentialCopyShell")], [test("worktree"), test("profile"), test("docker-git-signing-config")], ["private Git/filesystem Windows/Unix", "cross-UID SSH source; macOS runtime mount"]),
    packet("M12", ["M11"], [anchor("src/clipboard-server.ts", "createClipboardServer"), anchor("src/codex-launch.ts", "prepareCodexLaunch"), anchor("src/remote.ts", "remoteExec")], [test("clipboard-copy-server"), test("codex-launch"), test("remote-lifecycle-lock.integration")], ["macOS/Windows/Linux clipboard", "disposable remote SSH/Mutagen", "Codex PTY/runtime"]),
    packet("M13", ["M09", "M12"], [anchor("src/index.ts"), anchor("scripts/workspace-build.mjs"), anchor("scripts/install.js"), anchor("Dockerfile"), anchor("Containerfile")], [test("package"), test("codex-resume-package")], ["Windows/Unix installed package outside checkout; embedded distribution"]),
    packet("M14", ["M13"], [anchor(".github/workflows/ci.yml"), anchor("scripts/test-level.js")], [test("test-level-runner")], ["portable OS matrix", "explicit host-capable native/durability lanes; unavailable is not PASS"]),
];

export const packageBoundaries = [
    { manifest: "package.json", bin: "ccc", target: "dist/index.js", source: "src/index.ts", assets: ["Dockerfile", "scripts/install.js"] },
    { manifest: "packages/device-lab/package.json", bin: "ccc-device-broker", target: "./dist/broker-entry.js", source: "packages/device-lab/src/broker-entry.ts", assets: ["packages/device-lab/providers/backends/windows-helper.ps1"] },
] as const;
export const exportBoundaries = [
    { manifest: "packages/device-lab/package.json", key: "./providers/*", target: "./providers/*" },
    { manifest: "packages/hyper-v/package.json", key: "./lifecycle", target: { types: "./dist/lifecycle/index.d.ts", import: "./dist/lifecycle/index.js" } },
    { manifest: "packages/hyper-v/package.json", key: "./powershell/Invoke-HyperVWindowsOperation.ps1", target: "./powershell/Invoke-HyperVWindowsOperation.ps1" },
] as const;
export const invariantAnchors = [
    { concern: "TS owner-state validation", path: "packages/device-lab/src/device-lab-owner-state.ts", exports: ["readOwnerDeviceStateFile", "assertOwnerDeviceStateWritable"] },
    { concern: "shared owner-state validation parity", path: "packages/device-lab/providers/state/owner-device-state.mjs", exports: ["readOwnerDeviceStateFile"] },
    { concern: "provider lock and generation transition", path: "packages/device-lab/providers/state/device-store.mjs", exports: ["withOwnerDeviceOperation", "transitionOwnerDeviceRecord"] },
    { concern: "state validation/storage", path: "packages/device-lab/src/device-lab-state-file.ts", exports: ["readDeviceLabStateFile", "assertDeviceLabPathWithinRoot"] },
    { concern: "owner authority", path: "packages/device-lab/src/device-lab-owner.ts", exports: ["deviceLabOwnerId"] },
    { concern: "provider long-lock selection", path: "packages/device-lab/providers/state/device-operation-policy.mjs", exports: ["requiresOwnerDeviceOperation"] },
    { concern: "container lock ownership", path: "src/session.ts", exports: ["withContainerLifecycleLock", "withProjectFamilyLifecycleLock"] },
] as const;
