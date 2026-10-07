import { describe, expect, it, vi } from "vitest";
import { waitForStartReadiness } from "../../packages/device-lab/providers/application/start-readiness.mjs";
import { readinessProbeBudget } from "../../packages/device-lab/providers/domain/readiness.mjs";
import type { ReadinessProbeBudget } from "../../packages/device-lab/providers/domain/readiness.mjs";

describe("desktop readiness application ports", () => {
    it("does not invoke transport after the start budget is consumed", async () => {
        const probe = vi.fn();
        const sleep = vi.fn();
        expect(await waitForStartReadiness(100, { probe, now: () => 100, sleep })).toEqual({
            kind: "timed-out", readiness: { attempts: 0, lastProbe: "not-attempted" },
        });
        expect(probe).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });
    it("shares one shrinking budget across failures and success", async () => {
        let time = 0;
        const probe = vi.fn(async (_budget: ReadinessProbeBudget) => {
            time += 100;
            return { ready: time > 100, failed: false };
        });
        const sleep = vi.fn(async (ms: number) => { time += ms; });
        expect(await waitForStartReadiness(15000, { probe, now: () => time, sleep })).toEqual({ kind: "ready" });
        expect(probe.mock.calls).toEqual([[{ timeoutMs: 10000, remainingMs: 15000 }], [{ timeoutMs: 10000, remainingMs: 14400 }]]);
        expect(sleep.mock.calls).toEqual([[500]]);
    });
    it.each([
        [0, undefined], [-1, undefined], [0.5, { timeoutMs: 0.5, remainingMs: 0.5 }],
        [10000, { timeoutMs: 10000, remainingMs: 10000 }],
        [15000, { timeoutMs: 10000, remainingMs: 15000 }],
    ])("preserves the positive probe budget and cap: %s", (remaining, expected) => {
        expect(readinessProbeBudget(remaining as number, 0)).toEqual(expected);
    });
    it.each([[1000, "ready"], [1001, "timed-out"]])("accepts readiness only through deadline: %s", async (arrival, kind) => {
        let time = 0;
        const outcome = await waitForStartReadiness(1000, {
            now: () => time,
            sleep: async () => { throw new Error("no sleep after deadline"); },
            probe: async () => { time = arrival as number; return { ready: true, failed: false }; },
        });
        expect(outcome.kind).toBe(kind);
        if (outcome.kind === "timed-out") expect(outcome.readiness.lastProbe).toBe("late-response");
    });
    it("preserves classified evidence across transport exceptions without exposing them", async () => {
        let time = 0;
        let attempts = 0;
        const outcome = await waitForStartReadiness(750, {
            now: () => time,
            sleep: async (ms: number) => { time += ms; },
            probe: async () => {
                if (++attempts === 1) return { ready: true, failed: true, helper: { stage: "response-timeout" } };
                throw new Error("PRIVATE HOST OUTPUT");
            },
        });
        expect(outcome).toEqual({ kind: "timed-out", readiness: {
            attempts: 2, lastProbe: "transport-exception", helper: { stage: "response-timeout" }, helperAttempt: 1,
        } });
        expect(time).toBe(750);
        expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    });
    it("does not dispatch if the clock reaches the deadline between budget reads", async () => {
        const now = vi.fn().mockReturnValueOnce(999).mockReturnValue(1000);
        const probe = vi.fn();
        expect(await waitForStartReadiness(1000, { now, probe, sleep: vi.fn() })).toMatchObject({
            kind: "timed-out", readiness: { attempts: 0 },
        });
        expect(probe).not.toHaveBeenCalled();
    });
});
