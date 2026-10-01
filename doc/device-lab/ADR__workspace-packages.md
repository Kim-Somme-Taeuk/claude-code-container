# Device Lab workspace packages

CCC remains one installable CLI. Its independently buildable npm workspaces are
`@ccc/hyper-v`, `@ccc/device-lab`, and `@ccc/device-lab-mcp`.

The dependency direction is CCC / MCP → Device Lab → Hyper-V. Hyper-V owns its
typed Windows library and operation PowerShell asset. Device Lab owns providers,
broker, state, platform utilities, the remaining Hyper-V PowerShell assets, and
the pinned Appium runtime manifest and lock. MCP owns protocol transport, public
tool schemas, validation, and response presentation. Providers never import MCP
or CCC source. Shared project identity belongs to Device Lab and is reused by CCC.

The TypeScript workspaces, Hyper-V and Device Lab, expose compiled JavaScript
and declarations through explicit exports. MCP exports its `.mjs` entries and
builds a server bundle. Provider modules and PowerShell assets retain their
package-relative layout.
The three extracted packages have their own build and test entries; root build
composes those builds. X11 is an internal Device Lab provider; its duplicate
standalone MCP is removed. CCC retains the display runtime and clipboard bridge.
See [unified display control](REQ__unified-display-control.md). Vitest resolves workspace modules to source so
unit-test watch observes edits; subprocess distribution tests use built artifacts.

CCC's distribution embeds the runtime packages under `dist/packages/<name>`.
Assembly rewrites package imports in this embedded copy to relative paths. The
standalone workspace builds retain normal package dependencies. CCC diagnostics
use private package import mappings to those embedded artifacts; the Unix
installer preserves those mappings. Thus the Unix
installer, which copies no node_modules, can run after the checkout is removed.
The CLI entry remains `dist/index.js`; bundled MCP entry paths remain unchanged.

Docker builders copy workspace manifests before `npm ci` and package sources
before building. Runtime images include provider and pinned Appium assets. The
installation content hash covers packages. Package acceptance includes builds,
types, unit and PowerShell checks, and extracted distribution smoke tests outside
the checkout. Native Windows, macOS, and mobile provider acceptance is separate.

Real-test artifact preparation follows the same package build and assembly
order. Building only the root TypeScript outputs restores workspace imports in
the CLI and can make broker process verification expect a different entry path.
Level 3 and nested tests build workspace dependencies before the CLI and finish
by assembling the embedded runtime, without weakening broker identity checks.

The shared broker protocol advances to version 2 because loaded version 1
daemons retain the removed asset paths. CCC supplies its known legacy CLI path
for exact process identity verification, then replaces an incompatible broker
with the package-owned entry. PID, port, start-token and owner fences remain.

This move preserves provider behavior and existing local changes. It does not
assert that the outstanding nested Hyper-V native test has passed.
