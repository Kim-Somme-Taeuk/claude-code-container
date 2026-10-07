# Stale nested worktree registration during workspace creation

## Intent

When `ccc` creates a unified workspace, an initialized nested repository may
still register the exact destination even though that destination is absent.
Creation should recover this case without discarding Git metadata or touching
another worktree.

## Required behavior

- Before creating the nested worktree, verify that the destination is absent,
  the Git registration names that exact path and branch, and its management
  backpointer and HEAD agree with the source repository and branch commit.
  On Windows, the existing parent directory must be the same observed object;
  matching path text alone is insufficient.
- A single matching, unlocked registration may be moved into a private
  quarantine outside Git's worktree registry. The new worktree may then be
  created. Preserve the old metadata in quarantine after success and print
  its path. If the old checkout returns, its Git link must be reconciled
  before it is used.
- If nested creation or a later step fails, remove any replacement registration
  under the normal ownership checks, then restore the old registration. If
  ownership changed and safe restoration cannot be proven, preserve the
  quarantine and report its path with the rollback failure.
- A locked registration, a live destination, another branch or path, ambiguous
  or foreign management data, or a changed source/destination identity must
  be refused without force, prune, or deletion of working files.

## Verification

Use real Git repositories to cover recreation, retained HEAD/index metadata,
locked refusal, and restoration after a later nested failure. Run the worktree
suite and build. Validate Windows path identity behavior in Windows CI.
