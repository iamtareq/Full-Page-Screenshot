# Releasing an update (admin — Tareq)

When you change the code and want the whole team to get it, **no more sending files** —
just push, and everyone's popup shows an "Update available" banner.

## Push an update
1. Make your edits.
2. Bump the version **in BOTH files to the same new number**:
   - `manifest.json` → `"version"`
   - `version.json`  → `"version"`
   (the popup compares the installed `manifest.json` version against the repo's
   `version.json`; if the repo is higher, teammates see the banner)
3. Commit, **tag**, & push:
   ```
   git add -A
   git commit -m "v1.1.0: what changed"
   git tag -a v1.1.0 -m "v1.1.0: what changed"
   git push --follow-tags
   ```
   The tag is what makes that release a named point someone can go back to — see
   **Rolling back** below. A release without a tag cannot be rolled back to by name.

## Rolling back

Every release is tagged, so any of them can be restored by name.

A teammate double-clicks **`rollback.cmd`**, picks a version from the list (or types
`latest` to come forward again), then reloads at `chrome://extensions`. To check it
worked they open the popup — the footer shows the version they are now on.

Two things that script deliberately does, and why:

- **It stays on `main`** (`git reset --hard <tag>`) instead of checking the tag out.
  A checked-out tag leaves git in a detached HEAD, and the one-click updater's host
  reads the branch with `git rev-parse --abbrev-ref HEAD` — which returns `HEAD` when
  detached. It would then `reset --hard origin/HEAD` and silently pull the person
  forward again, undoing their rollback with no warning.
- **It refuses when the working tree is dirty**, because `reset --hard` would throw
  those edits away. It prints what it found and stops.

A rollback is not permanent: clicking **"Update now"** in the popup, or running
`update.cmd`, brings that person forward to the newest version again. That is also the
way back for anyone who rolled back far enough that `rollback.cmd` itself is not in the
files any more.

If a release turns out to be bad for *everyone*, roll the repo back rather than asking
twelve people to: `git revert <bad commit>`, bump the version again, and push. Everyone
then gets the fix through the normal banner.

## What a teammate does when they see the "Update available" banner
- **If they ran `install-updater.cmd` once (recommended):** just click **"Update now"**
  in the popup — it pulls the update and reloads the extension automatically. Done.
- **Otherwise (fallback):** double-click **`update.cmd`**, then `chrome://extensions` →
  **Reload** (or restart Chrome). Since v1.3.0 it takes the same steps as "Update now":
  it fetches, refuses local edits, then makes the folder exactly what is on GitHub. (Up to
  v1.2.x it ran `git pull`, which merges - and a merge fails for good once the history on
  GitHub has been re-written.)

## First-time setup for a new teammate
```
git clone https://github.com/iamtareq/Full-Page-Screenshot.git
```
1. `chrome://extensions` → Developer mode ON → **Load unpacked** → pick the folder.
2. Double-click **`install-updater.cmd`** once → enables the one-click **"Update now"**
   button (registers a tiny local git helper via native messaging).
3. Add their Gmail as an OAuth **Test user** so Send to Drive works.

> The "Update now" button needs the extension to already be on the version that has it
> (v1.0.2+). Teammates on an older version update once the normal way (`update.cmd` +
> reload) to get it, then run `install-updater.cmd` — after that every future update is
> one click.

## Notes
- The "Update available" banner only works while the repo is **public** (so GitHub's
  raw `version.json` can be read without a token). If you keep it private, the banner
  is skipped but `update.cmd` still works.
- Teammates need **Git** installed to use `update.cmd` / clone.
- `*.pem` signing keys are git-ignored and must stay out of the repo.
- `.gitattributes` makes `update.cmd` (and any new `.cmd`/`.bat`) CRLF on every PC: cmd.exe
  mis-reads labels and `goto` in an LF-only batch file. `rollback.cmd`, `install-updater.cmd`
  and `updater/fpc-update-host.bat` are exempt (`!text !eol`): versions before v1.3.0 have no
  `.gitattributes` and check them out with the PC's own line endings, and both sides of a
  rollback must match (rollback.cmd resumes at a byte offset; a CRLF copy of an unchanged
  file shows up as a local edit on v1.2.x). Never drop those three lines.
- `updater\fpc-update-host.bat` is replaced while cmd.exe is still running it (the reset runs
  inside its PowerShell line), and cmd then resumes at the old end-of-file offset of the NEW
  file. If you ever change that .bat, keep it no longer than it is now (420 bytes LF / 426
  CRLF), or make sure that offset lands on a harmless line.
- `update.cmd` copies itself into its own `%TEMP%\fpc-update-<n>` folder and removes it at the
  end with `rd` (no `/s`). Keep the copy inside that private folder: the `rd` removes the
  folder the copy runs from.
- **Never tidy the block of colons at the top of `update.cmd`.** The old `update.cmd`
  (v1.0.0-v1.2.x) runs `git pull`, which replaces the file while cmd.exe is still reading it;
  cmd then resumes at byte 176 (LF) / 183 (CRLF) of the NEW file. Those bytes must stay
  inside `:::` label lines. From v1.3.0 on, update.cmd runs from a copy in %TEMP%, so later
  versions can change it freely.
- `rollback.cmd` rewrites itself when it resets to an older version, and cmd resumes at the
  same byte offset. Keep every line above its `git reset --hard "!PICK!"` line the same
  total length across versions (v1.3.0 shortened a comment by exactly the 3 bytes it added
  to the fetch line).

## If the history on GitHub is ever re-written (force push)
File contents stay the same; only commit ids and tags move. From v1.3.0, "Update now",
`update.cmd` and `rollback.cmd` all fetch with `--tags --force` and reset to GitHub, so they
follow on their own. Anyone still on v1.2.x or older, or stuck, runs this once in the
extension folder (it throws away local edits, like the updater does):
```
git fetch --prune --tags --force origin
git reset --hard origin/main
```
or simply clones afresh. Only force-push after the team is on v1.3.0 or later.
