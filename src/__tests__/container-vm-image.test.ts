import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const vmPackages = [
    "qemu-system-x86",
    "qemu-utils",
    "ovmf",
    "cpu-checker",
];

function readRepoFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

function userSetup(path: string): string {
    const content = readRepoFile(path);
    const section = content.slice(content.indexOf("# LAYER 5: User setup"));
    return section.slice(section.indexOf("RUN ") + 4, section.indexOf("\n\n# Localhost proxy"))
        .replace(/\\\r?\n/g, "\n");
}

describe("default container identity", () => {
    it("keeps Docker and Podman account setup identical", () => {
        expect(userSetup("Dockerfile")).toBe(userSetup("Containerfile"));
    });

    it.each(["Dockerfile", "Containerfile"])("%s preserves named user runtime contracts", (path) => {
        const setup = userSetup(path);
        expect(setup).toContain("useradd -m -u 1000 -g ccc -d /home/ccc -s /bin/bash ccc");
        expect(setup).toContain("groupadd -o -g 1000 ccc");
        expect(setup).toContain("useradd -r -s /usr/sbin/nologin ccc-proxy");
        expect(setup).toContain("ccc ALL=(ALL) NOPASSWD:ALL");
        expect(setup).toContain("usermod -aG docker ccc");
        expect(readRepoFile(path).match(/^USER .+$/gm)?.at(-1)).toBe("USER ccc");
    });

    it.each([
        ["", true, false],
        ["ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash", true, true],
        ["another:x:1000:1000::/home/another:/bin/bash", false, false],
        ["ubuntu:x:1000:1000::/srv/ubuntu:/bin/bash", false, false],
    ])("handles UID 1000 owner %j safely", (owner, accepted, removed) => {
        // Execute the real shell decision with account mutations intercepted.
        // Stop before filesystem/sudo setup so this never changes host state.
        const setup = userSetup("Dockerfile").split("    chmod o+x")[0];
        const result = spawnSync("/bin/sh", ["-c", `
getent() { [ -n "$TEST_UID_OWNER" ] && printf '%s\\n' "$TEST_UID_OWNER"; }
userdel() { printf 'userdel %s\\n' "$*"; }
groupadd() { printf 'groupadd %s\\n' "$*"; }
useradd() { printf 'useradd %s\\n' "$*"; }
${setup}
`], { encoding: "utf8", env: { ...process.env, TEST_UID_OWNER: owner } });
        expect(result.status).toBe(accepted ? 0 : 1);
        expect(result.stdout.includes("userdel ubuntu\n")).toBe(removed);
        if (accepted) {
            expect(result.stdout).toContain("groupadd -o -g 1000 ccc\n");
            expect(result.stdout).toContain("useradd -m -u 1000 -g ccc -d /home/ccc -s /bin/bash ccc\n");
        } else {
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("UID 1000 belongs to an unrelated account");
        }
    });
});

describe("container VM image prerequisites", () => {
    it.each(["Dockerfile", "Containerfile"])("%s includes QEMU/KVM userland packages", (path) => {
        const content = readRepoFile(path);

        for (const packageName of vmPackages) {
            expect(content).toContain(packageName);
        }
    });

    it.each(["Dockerfile", "Containerfile"])("%s bakes bundled CCC MCP servers into /opt/ccc/dist", (path) => {
        const content = readRepoFile(path);

        expect(content).toContain("FROM node:22-slim AS mcp-builder");
        expect(content).toContain("npm run build:x11-mcp && npm run build:device-lab-mcp && npm run build:lab-mcp");
        expect(content).toContain("COPY --from=mcp-builder --chown=ccc:ccc /build/dist/device-lab-mcp /opt/ccc/dist/device-lab-mcp");
        expect(content).toContain("COPY --from=mcp-builder --chown=ccc:ccc /build/dist/lab-mcp /opt/ccc/dist/lab-mcp");
    });
});
