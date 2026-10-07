import { describe, expect, it, vi } from "vitest";
import { parseRuntimeOverride, type RuntimeName } from "../../domain/container-runtime.js";
import { createContainerRuntimeSelector } from "../../application/container-runtime-selection.js";
import type { ContainerRuntimeSelectionPorts } from "../../ports/container-runtime-selection.js";

const unavailableMessage = "No container runtime found. Install podman or docker and ensure the CLI is on PATH.";
const invalidMessage = (value: string, source: "cli" | "environment") =>
    `Invalid ${source === "cli" ? "--runtime" : "CCC_RUNTIME"} value: '${value}'. Allowed: 'docker' or 'podman'.`;

describe("runtime override domain contract", () => {
    for (const source of ["cli", "environment"] as const) {
        it.each(["docker", "podman"] as const)(`accepts exact %s from ${source}`, runtime => {
            expect(parseRuntimeOverride(runtime, source)).toBe(runtime);
        });
        it.each([null, undefined, ""])(`returns no override for %s from ${source}`, value => {
            expect(parseRuntimeOverride(value, source)).toBeNull();
        });
        it.each(["lxc", " ", " docker", "podman ", "DOCKER", "Podman", "도커", "docker\u00a0"])(
            `rejects unnormalized %s from ${source} with the original error`, value => {
                expect(() => parseRuntimeOverride(value, source)).toThrowError(new Error(invalidMessage(value, source)));
            },
        );
    }
});

function ports(): ContainerRuntimeSelectionPorts {
    return {
        getExplicitOverride: () => null,
        getEnvironmentOverride: () => undefined,
        isRuntimeAvailable: () => false,
    };
}

describe("explicit synchronous runtime selection", () => {
    it.each([undefined, null])("rejects absent port objects (%s) before effects", value => {
        expect(() => createContainerRuntimeSelector(value as unknown as ContainerRuntimeSelectionPorts)).toThrow(TypeError);
    });

    for (const member of ["getExplicitOverride", "getEnvironmentOverride", "isRuntimeAvailable"] as const) {
        it(`rejects missing ${member} before invoking any callback`, () => {
            const callbacks = { getExplicitOverride: vi.fn(), getEnvironmentOverride: vi.fn(), isRuntimeAvailable: vi.fn() };
            const invalid: Record<string, unknown> = { ...callbacks };
            delete invalid[member];
            expect(() => createContainerRuntimeSelector(invalid as unknown as ContainerRuntimeSelectionPorts)).toThrow(TypeError);
            for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
        });
        it.each([null, false, 1, "docker", {}])(`rejects noncallable ${member} (%s) before effects`, value => {
            const callbacks = { getExplicitOverride: vi.fn(), getEnvironmentOverride: vi.fn(), isRuntimeAvailable: vi.fn() };
            expect(() => createContainerRuntimeSelector({ ...callbacks, [member]: value } as unknown as ContainerRuntimeSelectionPorts)).toThrow(TypeError);
            for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
        });
    }

    it("construction does not read any supplied port", () => {
        const callbacks = { getExplicitOverride: vi.fn(() => null), getEnvironmentOverride: vi.fn(() => undefined), isRuntimeAvailable: vi.fn(() => false) };
        expect(createContainerRuntimeSelector(callbacks)).toBeTypeOf("function");
        for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    });

    it.each(["docker", "podman"] as const)("explicit %s wins without reading poisoned environment or availability", runtime => {
        const trace: string[] = [];
        const selector = createContainerRuntimeSelector({
            getExplicitOverride: () => { trace.push("explicit"); return runtime; },
            getEnvironmentOverride: () => { throw new Error("environment must remain unread"); },
            isRuntimeAvailable: () => { throw new Error("availability must remain unread"); },
        });
        expect(selector()).toBe(runtime);
        expect(trace).toEqual(["explicit"]);
    });

    it.each(["docker", "podman"] as const)("environment %s wins without availability effects", runtime => {
        const trace: string[] = [];
        const selector = createContainerRuntimeSelector({
            getExplicitOverride: () => { trace.push("explicit"); return null; },
            getEnvironmentOverride: () => { trace.push("environment"); return runtime; },
            isRuntimeAvailable: () => { throw new Error("availability must remain unread"); },
        });
        expect(selector()).toBe(runtime);
        expect(trace).toEqual(["explicit", "environment"]);
    });

    it.each(["lxc", " ", "DOCKER", "podman ", "도커"])("invalid environment %s fails without availability", value => {
        const trace: string[] = [];
        const selector = createContainerRuntimeSelector({
            getExplicitOverride: () => { trace.push("explicit"); return null; },
            getEnvironmentOverride: () => { trace.push("environment"); return value; },
            isRuntimeAvailable: () => { throw new Error("availability must remain unread"); },
        });
        expect(selector).toThrowError(new Error(invalidMessage(value, "environment")));
        expect(trace).toEqual(["explicit", "environment"]);
    });

    for (const environment of [undefined, ""]) {
        it.each([
            [true, true, "podman", ["podman"]],
            [true, false, "podman", ["podman"]],
            [false, true, "docker", ["podman", "docker"]],
            [false, false, null, ["podman", "docker"]],
        ] as const)(`availability %s/%s with environment ${String(environment)} preserves order`, (podman, docker, expected, probes) => {
            const trace: string[] = [];
            const selector = createContainerRuntimeSelector({
                getExplicitOverride: () => { trace.push("explicit"); return null; },
                getEnvironmentOverride: () => { trace.push("environment"); return environment; },
                isRuntimeAvailable: runtime => { trace.push(runtime); return runtime === "podman" ? podman : docker; },
            });
            if (expected === null) expect(selector).toThrowError(new Error(unavailableMessage));
            else expect(selector()).toBe(expected);
            expect(trace).toEqual(["explicit", "environment", ...probes]);
        });
    }

    it.each(["explicit", "environment", "podman", "docker"] as const)("propagates the same exception from %s and stops", failing => {
        const exception = { reason: failing };
        const trace: string[] = [];
        function observe(name: string): void {
            trace.push(name);
            if (name === failing) throw exception;
        }
        const selector = createContainerRuntimeSelector({
            getExplicitOverride: () => { observe("explicit"); return null; },
            getEnvironmentOverride: () => { observe("environment"); return undefined; },
            isRuntimeAvailable: runtime => { observe(runtime); return false; },
        });
        let caught: unknown;
        try { selector(); } catch (error) { caught = error; }
        expect(caught).toBe(exception);
        const ordered = ["explicit", "environment", "podman", "docker"];
        expect(trace).toEqual(ordered.slice(0, ordered.indexOf(failing) + 1));
    });

    it("reads current explicit and environment inputs each time without caching selection", () => {
        let explicit: RuntimeName | null = null;
        let environment: string | undefined = "docker";
        const available = vi.fn(() => true);
        const selector = createContainerRuntimeSelector({
            getExplicitOverride: () => explicit,
            getEnvironmentOverride: () => environment,
            isRuntimeAvailable: available,
        });
        expect(selector()).toBe("docker");
        environment = "podman";
        expect(selector()).toBe("podman");
        explicit = "docker";
        environment = "invalid";
        expect(selector()).toBe("docker");
        expect(available).not.toHaveBeenCalled();
    });

    it("passes only typed runtime names into availability", () => {
        const available = vi.fn<(runtime: RuntimeName) => boolean>(() => false);
        const selector = createContainerRuntimeSelector({ ...ports(), isRuntimeAvailable: available });
        expect(selector).toThrowError(new Error(unavailableMessage));
        expect(available.mock.calls).toEqual([["podman"], ["docker"]]);
    });
});
