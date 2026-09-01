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
3. Commit & push:
   ```
   git add -A
   git commit -m "v1.1.0: what changed"
   git push
   ```

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
