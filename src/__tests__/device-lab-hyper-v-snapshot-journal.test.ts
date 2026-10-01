import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    readHyperVSnapshotJournal,
    recordHyperVSnapshotCreatedId,
    writeHyperVSnapshotJournal,
    type HyperVJournalPersistenceRuntime,
} from "@ccc/device-lab/device-lab/broker/hyper-v/operation-journal.js";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hyper-V staged snapshot create journal", () => {
    it("requires exact confirmation before mutation and records only the returned native id", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-snapshot-journal-"));
        roots.push(root);
        const runtime: HyperVJournalPersistenceRuntime = {
            deviceRoot: () => root,
            ensurePrivateDeviceRoot: () => root,
            readDevices: () => [],
            journalLimitBytes: 4096,
        };
        const ownerId = "0123456789abcdef";
        const deviceId = "linux-snapshot";
        const incarnationId = "11111111111111111111111111111111";
        const providerName = `ccc-${ownerId}-baseline`;
        const snapshotId = "11111111-2222-3333-4444-555555555555";
        writeHyperVSnapshotJournal(runtime, ownerId, "linux-vm", deviceId, incarnationId,
            "device_snapshot_create", "baseline", providerName, undefined, "Production");
        const pending = readHyperVSnapshotJournal(runtime, ownerId, "linux-vm", deviceId);
        expect(pending).toEqual(expect.objectContaining({ confirmationRequired: true }));
        expect(pending).not.toHaveProperty("snapshotId");

        recordHyperVSnapshotCreatedId(runtime, ownerId, "linux-vm", deviceId, incarnationId, providerName, snapshotId);
        const recorded = readHyperVSnapshotJournal(runtime, ownerId, "linux-vm", deviceId);
        expect(recorded).toEqual(expect.objectContaining({
            confirmationRequired: true,
            snapshotId,
            operationId: pending?.operationId,
            startedAt: pending?.startedAt,
        }));
        expect(() => recordHyperVSnapshotCreatedId(runtime, ownerId, "linux-vm", deviceId,
            incarnationId, providerName, "99999999-8888-7777-6666-555555555555"))
            .toThrow("hyper-v-snapshot-created-id-journal-mismatch");
    });
});
