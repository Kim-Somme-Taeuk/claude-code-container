# Codex container sandbox prerequisites

CCC images include the distribution bubblewrap package, exposing `bwrap` on
the normal user's PATH. Preparing Codex in an existing container checks for
the executable, installs the package when missing, and verifies it afterward.
Installation failure prevents a successful readiness report. Already installed
dependencies do not trigger package updates. This does not disable Codex's
sandbox, change approvals, or change host kernel restrictions.

Verification covers existing and missing binaries, installation failures, and
an actual isolated command with bwrap where user namespaces are available.

Source: [OpenAI sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites).
