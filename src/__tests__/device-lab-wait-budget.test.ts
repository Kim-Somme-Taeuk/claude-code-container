import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaitBudget } from "@ccc/device-lab/providers/wait-budget.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("shared monotonic observation budget", () => {
    it.each([[undefined, 10000], [0, 1], [-2, 1], [NaN, 10000], [Infinity, 10000], ["10", 10000], [900000, 600000], [2.9, 2]])("normalizes timeout %s to %s", (input, expected) => {
        vi.spyOn(performance, "now").mockReturnValue(100);
        const budget = createWaitBudget(input, 10);
        expect(budget.timeoutMs).toBe(expected);
        expect(budget.remaining()).toBe(expected);
    });
    it("shrinks across requests, rounds fractional allowances up, and never restarts after expiry", () => {
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const budget = createWaitBudget(200000, 500);
        expect(budget.requestTimeout()).toBe(120000);
        clock = 199950.5;
        expect(budget.requestTimeout()).toBe(50);
        expect(budget.requestTimeout(20)).toBe(20);
        clock = 200001;
        expect(budget.remaining()).toBe(0);
        expect(budget.requestTimeout()).toBe(0);
    });
    it("finishes a fractional final pause without starting a tiny extra observation", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const schedule = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
            schedule(() => {
                // Model Node's integer-millisecond timer scheduling explicitly.
                clock += Math.max(1, Math.trunc(delay));
                callback();
            }, delay)) as typeof setTimeout);
        const budget = createWaitBudget(100, 500);
        clock = 90.5;
        let observations = 1;
        const pending = budget.pause().then(() => {
            if (budget.remaining() > 0) observations++;
        });
        await vi.runAllTimersAsync();
        await pending;
        expect(observations).toBe(1);
        expect(budget.requestTimeout()).toBe(0);
    });
    it.each([[0, 1], [-2, 1], [NaN, 500], [Infinity, 500], ["10", 500], [90000, 60000]])("normalizes interval %s and caps the final sleep", async (input, expected) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const timer = vi.spyOn(globalThis, "setTimeout");
        const budget = createWaitBudget(100000, input);
        const initial = budget.pause();
        expect(timer.mock.calls[0][1]).toBe(expected);
        await vi.runAllTimersAsync();
        await initial;
        clock = 99999.5;
        const final = budget.pause();
        expect(timer.mock.calls[1][1]).toBe(1);
        await vi.runAllTimersAsync();
        await final;
        clock = 100000;
        await budget.pause();
        expect(timer).toHaveBeenCalledTimes(2);
    });
});
