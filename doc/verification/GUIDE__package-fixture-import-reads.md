# Package fixture import reads

Node 22.23.3 can load ESM source through the patched `fs.readFileSync` export.
An import-time manifest-only replacement therefore rejects legitimate source
loading. Distribution fixtures use `scripts/fixtures/owned-import-read.mjs`
to distinguish source loading from product manifest reads.

The import phase admits absolute string paths or plain file URLs for the exact
owned manifest and regular `.js`/`.mjs` files below the payload's compiled root.
Sibling roots, arbitrary JSON/data, descriptors, URL aliases, symlinks (including
directory ancestors), hardlinks and nonregular files are rejected. The helper
captures inspection/read primitives before patches and preserves read arguments
and original filesystem failures. This is a fixture boundary, not a production
filesystem security API or protection against concurrent hostile tree mutation.

Registry-first loading restricts compiled sources to the public registry and its
two domain modules, and separately requires zero product manifest reads. Setup
loading opens the remaining owned compiled source graph. After imports finish,
the allowance closes and the existing full filesystem/process fences apply to
actual public calls. `finally` restores exports and synchronizes ESM bindings.

Run `node --test scripts/fixtures/owned-import-read.test.mjs` followed by
`npm run test:packages` with each pinned Node runtime. The package command checks
both extracted npm packages and materialized installation payloads. Keep artifact
writers and consumers sequential and use isolated HOME/TMP directories. In this
workspace, execute only in the Linux verification copy, never the shared 9p root.

The focused suite checks the ownership boundary; package tests check real compiled
facades and both registry/setup import orders. Neither proves native provider E2E
or Windows/macOS acceptance. Record tested runtimes and command results in the
task's independent QA evidence before claiming compatibility.
