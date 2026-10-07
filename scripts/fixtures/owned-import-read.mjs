// Self-contained: distribution fixtures serialize this function into fresh children.
export async function createOwnedImportRead(rootUrl, manifestUrl, label) {
    const fs = (await import("node:fs")).default;
    const { dirname, isAbsolute, relative, resolve, sep, extname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const read = fs.readFileSync;
    const lstat = fs.lstatSync;
    const realpath = fs.realpathSync;
    const root = resolve(fileURLToPath(rootUrl));
    const manifest = resolve(fileURLToPath(manifestUrl));
    let closed = false;
    let sources = null;
    let manifestReads = 0;
    const deny = () => { throw new Error(`${label}: unowned import-time read`); };
    function pathOf(selected) {
        if (selected instanceof URL) {
            if (selected.protocol !== "file:" || selected.search || selected.hash) return deny();
            return resolve(fileURLToPath(selected));
        }
        if (typeof selected !== "string" || !isAbsolute(selected)) return deny();
        return resolve(selected);
    }
    function owned(path) {
        const offset = relative(root, path);
        return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
    }
    // The payload root and every component below it must be real, owned paths.
    if (!lstat(root).isDirectory() || lstat(root).isSymbolicLink() || realpath(root) !== root) deny();
    return {
        restrictSources(urls) { sources = urls === null ? null : new Set(urls.map(pathOf)); },
        close() { closed = true; },
        get manifestReads() { return manifestReads; },
        read(selected, ...args) {
            if (closed) return deny();
            const path = pathOf(selected);
            const isManifest = path === manifest;
            if (!owned(path) || (!isManifest && (!/^(?:\.js|\.mjs)$/.test(extname(path))
                || (sources !== null && !sources.has(path))))) return deny();
            for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
                const stat = lstat(parent);
                if (!stat.isDirectory() || stat.isSymbolicLink()) return deny();
            }
            const stat = lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpath(path) !== path) return deny();
            if (isManifest) manifestReads++;
            return read(selected, ...args);
        },
    };
}
