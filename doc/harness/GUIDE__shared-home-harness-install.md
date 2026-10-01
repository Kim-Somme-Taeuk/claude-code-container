# Harness installation in the shared CCC Codex home

Run the reviewed Harness source installer inside the target container so its
MCP and hook commands use container paths. Installing the host's Codex home
does not update CCC's separately mounted `~/.ccc/codex` home.

When the shared home's owner differs from the container user, use a reviewed
installer that supports `--shared-codex-home-owner`, with the actual numeric
host owner verified from the mount. The option requires effective ACL write
access to be limited to that owner and the runtime user; it does not authorize
general group write, other users, or insecure installed payload files.

For the current Docker layout, the host owner is UID 1000 and CCC runs as UID
1001. From the reviewed source directory inside the container:

```sh
python3 install.py --codex-only --shared-codex-home-owner 1000
```

Run the same command again to check for `SYNCHRONIZED`, then run CCC's Harness
readiness probe and compare the installed scripts with the reviewed source.
Keep the shared directory's owner, mode and ACL unchanged. Do not use `--force`
to suppress an unsafe-ancestor refusal. Existing loaded MCP processes can keep
old Python modules until a new Codex session starts.

The readiness probe recognizes the canonical `PYTHONDONTWRITEBYTECODE=1`
prefix before checking the hook executable and script. Hook trust hashes still
cover the original complete command, including that prefix. Unknown prefixes
remain invalid.

The default upstream bootstrap pin does not include this local compatibility
option. Preserve the reviewed local source checkout for subsequent deployment;
an upstream reinstall can replace the local fix.
