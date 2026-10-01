# Optional mise configuration prompt

`mise.toml` selects project tool versions (for example Node or Python). When
neither `mise.toml` nor `.mise.toml` exists and version-related project files
are detected, `ccc` offers to generate a configuration. Generation is optional;
declining continues startup without generating a file.

An explicit `n` or `no` (case-insensitive, surrounding whitespace ignored)
remembers the decline for that project across subsequent launches and profiles.
Later launches skip both the version-file scan and the creation question.
Other non-accepting responses skip only the current launch. Empty input, `y`
and `yes` retain their existing acceptance behavior.

Preferences are empty marker files in `~/.ccc/mise-prompt-skipped/<project-id>`.
The project ID uses CCC's normal lowercased/sanitized directory name followed
by the first 12 hex digits of SHA-256 of the resolved absolute project path.
Different paths, including separate worktrees, have separate preferences.
To restore the question, delete the corresponding marker from that directory.
No preference file is added to the project or removed with its container.

Users can create `mise.toml` or `.mise.toml` themselves at any time; a saved
decline does not disable normal mise configuration installation or use.
Projects without detected version files remain silent. If saving the decline
fails, CCC warns and continues startup; it may ask again next time.

Verification: `src/__tests__/mise-prompt.test.ts` covers repeated launches with
real temporary marker files, project isolation, reset, configuration presence,
acceptance and persistence failure. Startup integration remains covered by
`src/__tests__/codex-login-startup.test.ts`.
