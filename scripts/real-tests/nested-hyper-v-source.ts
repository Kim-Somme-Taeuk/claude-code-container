import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { dirname, join, resolve, sep } from "path";

// Only repository sources enter the guest. Never follow links into host secrets.
export function nestedSourceAllowed(name: string): boolean {
    const parts = name.split("/");
    return !name.includes("\\") && !name.includes("\0") && !name.includes(":")
        && parts.every(part => part && part !== "." && part !== ".."
            && ![".git", "node_modules", "results", "dist", ".ccc", ".codex", ".claude"].includes(part)
            && !/^\.env(?:\.|$)/i.test(part) && !/\.(?:pem|key|pfx|p12)$/i.test(part))
        && !name.startsWith("doc/harness/tasks/");
}

export function snapshotNestedSource(root: string, outputRoot: string) {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000, windowsHide: true,
    });
    if (listed.error || listed.status !== 0) {
        const processCode = (listed.error as NodeJS.ErrnoException | undefined)?.code;
        // Git errors can contain host paths, config values, or credentials. Classify
        // locally and retain only fixed codes; never persist the original stderr.
        const stderr = typeof listed.stderr === "string" ? listed.stderr.slice(0, 4096) : "";
        const detail = processCode === "ENOENT" ? "git-executable-or-working-directory-missing"
            : processCode === "ETIMEDOUT" ? "git-list-timed-out"
            : processCode === "ENOBUFS" ? "git-list-output-too-large"
            : /detected dubious ownership in repository/i.test(stderr) ? "git-dubious-ownership"
            : /not a git repository/i.test(stderr) ? "git-not-a-repository"
            : "git-list-command-failed";
        throw Object.assign(new Error("nested-source-git-list-failed"), {
            diagnosticPayload: {
                error: "nested-source-git-list-failed", detail,
                status: Number.isInteger(listed.status) ? listed.status : null,
                ...(listed.signal && /^SIG[A-Z0-9]{1,12}$/.test(listed.signal) ? { signal: listed.signal } : {}),
                ...(processCode ? { diagnosticCode: ["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES", "EPERM", "ENOMEM", "EINVAL", "E2BIG"].includes(processCode) ? processCode : "git-process-error" } : {}),
                timedOut: processCode === "ETIMEDOUT", outputRedacted: true,
            },
        });
    }
    mkdirSync(outputRoot, { recursive: true });
    const staging = mkdtempSync(join(outputRoot, "source-"));
    const archive = join(outputRoot, "source.tar.gz");
    let bytes = 0;
    try {
        for (const name of new Set(listed.stdout.split("\0").filter(nestedSourceAllowed))) {
            const source = resolve(root, name);
            if (!source.startsWith(resolve(root) + sep)) throw new Error("nested-source-path-invalid");
            let info;
            try { info = lstatSync(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
            for (let parent = dirname(source); parent !== resolve(root); parent = dirname(parent)) {
                if (lstatSync(parent).isSymbolicLink()) throw new Error(`nested-source-link: ${name}`);
            }
            if (!info.isFile() || info.isSymbolicLink()) throw new Error(`nested-source-not-regular: ${name}`);
            bytes += info.size;
            if (bytes > 512 * 1024 * 1024) throw new Error("nested-source-too-large");
            const destination = join(staging, name);
            mkdirSync(dirname(destination), { recursive: true });
            copyFileSync(source, destination);
        }
        const packed = spawnSync("tar", ["-czf", archive, "-C", staging, "."], { timeout: 120000, encoding: "utf8" });
        if (packed.status !== 0) throw new Error(`nested-source-tar-failed: ${packed.stderr}`);
        return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") };
    } finally { rmSync(staging, { recursive: true, force: true }); }
}
