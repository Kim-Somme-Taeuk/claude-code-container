export type RuntimeName = "docker" | "podman";

export function parseRuntimeOverride(
    value: string | undefined | null,
    source: "cli" | "environment",
): RuntimeName | null {
    if (value == null || value === "") return null;
    if (value === "docker" || value === "podman") return value;

    const label = source === "cli" ? "--runtime" : "CCC_RUNTIME";
    throw new Error(
        `Invalid ${label} value: '${value}'. Allowed: 'docker' or 'podman'.`,
    );
}
