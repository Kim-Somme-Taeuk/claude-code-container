# Own temporary environment files through command completion

The launch path now owns its environment file through argument construction,
preparation, session confirmation, command execution and existing ownership
restoration. A `finally` disposes the file on completion or error; a synchronous
process-exit listener covers handled exits while async work is pending. Cleanup
does not change the original command status or thrown value.

The existing string-returning writer keeps its serialization and naming. Both
writers share exclusive creation with mode `0600` and identity captured from the
creating descriptor before values are written. Owned disposal removes only a
matching regular file, preserves observed successors and uncertain identity,
unregisters its listener and contains fixed redacted diagnostics. It reads no
secret bytes for ownership proof and adds no global scan or guardian protocol.

Portable evidence includes native/public writer and launch regressions, eight
real emitted-process explicit-exit/disposal/successor/handled-signal cases, and
actual compiled utility lifecycle checks in both package payload forms.

Diagnostics use a synchronous FD write whose errors are contained. A real closed
stderr pipe regression preserves the chosen exit status; creation recovery also
reports a secondary descriptor-close failure once without replacing its primary
write error.

## Known ceiling

Known ceiling: SIGKILL cannot run parent cleanup, and env-file obligations are not
added to the session guardian. Native Windows deletion/console-close and macOS
tempfile behavior require native acceptance.

Known ceiling: unavailable inode identity fails before writing values and can
retain an uncertain empty placeholder. No pathname or secret digest substitutes
for ownership proof.

Known ceiling: the native identity-check-to-unlink window is not an atomic
hostile-filesystem guarantee. Observable replacements are protected.
