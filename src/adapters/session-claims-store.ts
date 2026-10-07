import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";

export function createSessionClaimsStore(location: { directory(): string; platform(): string }) {
    return {
        ensureDirectory(): undefined {
            mkdirSync(location.directory(), { recursive: true, mode: 0o700 });
            const observed = lstatSync(location.directory());
            if (!observed.isDirectory() || observed.isSymbolicLink()) {
                throw new Error("CCC session lock path must be a real directory");
            }
            if (location.platform() !== "win32") chmodSync(location.directory(), 0o700);
            return undefined;
        },
        listEntries(): string[] {
            return readdirSync(location.directory());
        },
        claimPath(name: string): string {
            return join(location.directory(), name);
        },
        claimName(path: string): string {
            return basename(path);
        },
        readClaim(name: string): string {
            return readFileSync(join(location.directory(), name), "utf-8");
        },
        writeClaim(path: string, content: string): undefined {
            writeFileSync(path, content, { mode: 0o600, flag: "wx" });
            return undefined;
        },
        removeClaim(path: string): undefined {
            unlinkSync(path);
            return undefined;
        },
    };
}
