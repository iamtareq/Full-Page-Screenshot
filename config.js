/* ─────────────────────────────────────────────────────────────────────────────
 * TEAM CONFIG  —  set once, share this folder with your team.
 *
 * The extension has a FIXED id (via manifest "key"), so one Google Cloud OAuth
 * client works for everyone. One-time admin setup:
 *   1. Create a Web-application OAuth client; add this redirect URI:
 *        https://eogbgpkhkkaaclemedgcdoaihnjnhnpb.chromiumapp.org/
 *   2. Add every teammate's Google email as a "Test user" on the consent screen
 *      (or have everyone sign in with one shared QA account).
 *   3. Paste the Client ID + target Drive folder below and redistribute this folder.
 * Teammates then just load the extension and sign in once — no per-person setup.
 *
 * (A user's own Settings values, if filled, override these.)
 * ───────────────────────────────────────────────────────────────────────────── */
self.FPC_TEAM = {
  clientId: "107096847408-pl68e1hcv91evqnpsk3rjr60613avsev.apps.googleusercontent.com",
  folderId: ""    // Drive folder URL or ID; blank = each user's Drive root
};
