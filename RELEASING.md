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
- **Otherwise (fallback):** double-click **`update.cmd`** (git pull), then
  `chrome://extensions` → **Reload** (or restart Chrome).

## First-time setup for a new teammate
```
git clone https://github.com/iamtareq/Full-Page-Screenshot.git
```
1. `chrome://extensions` → Developer mode ON → **Load unpacked** → pick the folder.
2. Double-click **`install-updater.cmd`** once → enables the one-click **"Update now"**
   button (registers a tiny local `git pull` helper via native messaging).
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
