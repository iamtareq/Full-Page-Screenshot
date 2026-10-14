/* Full Page Capture — the Google Drive transport, shared by the editor and the recorder.
 *
 * Everything here is free of the editor: no elements, no segments, no document model. The
 * editor keeps the parts that are not - driveExportBlob, driveFilename, copyDriveLink and
 * uploadToDrive all stay in result.js. Moved out of it unchanged (v1.6.0), except for
 * notifyDrive's optional notification id.
 */

/* ------------------------- Google Drive upload ------------------------- */
// Full drive scope so we can place the file in a user-chosen folder (the per-file
// drive.file scope can't write into a folder the app didn't create/open).
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

function parseFolderId(v) {
  if (!v) return "";
  v = String(v).trim();
  const inUrl = v.match(/\/folders\/([-\w]{20,})/);   // …/folders/<id>
  if (inUrl) return inUrl[1];
  if (/^[-\w]{20,}$/.test(v)) return v;                // a bare id
  return "";                                           // unrecognised → upload to root
}

async function getDriveSettings() {
  const s = await chrome.storage.sync.get("settings");
  const cfg = s.settings || {};
  const team = self.FPC_TEAM || {};
  return {
    // Per-user Settings win; otherwise fall back to the shared team config.
    clientId: ((cfg.driveClientId || "").trim()) || ((team.clientId || "").trim()),
    folderId: parseFolderId(cfg.driveFolderId || team.folderId || ""),
    shareAnyone: !!cfg.driveShareAnyone,
    linkLabel: cfg.driveLinkLabel === true ? (String(cfg.driveLinkLabelText || "").trim() || DRIVE_LABEL) : "",
    // Unset means this setting predates the choice: centre it, which is what the sheets the
    // label was built for use. "" is only ever a deliberate pick of "as it comes".
    linkAlign: cfg.driveLinkAlign === undefined ? "center"
             : (DRIVE_ALIGNS.indexOf(cfg.driveLinkAlign) > 0 ? cfg.driveLinkAlign : ""),
    // 0 / blank / nonsense = say nothing about the size, and let the sheet decide
    linkSize: (function (v) { const n = parseFloat(v); return isFinite(n) && n >= 6 && n <= 72 ? n : 0; })(cfg.driveLinkSize),
    linkMode: cfg.driveLinkMode === "formula" ? "formula" : "html"
  };
}

function parseAuthToken(resp) {
  if (!resp) return null;
  const p = new URLSearchParams((resp.split("#")[1] || ""));
  if (p.get("error")) return null;
  const token = p.get("access_token");
  if (!token) return null;
  return { token, exp: Date.now() + parseInt(p.get("expires_in") || "3600", 10) * 1000 };
}

async function launchAuth(authUrl, interactive) {
  try {
    return parseAuthToken(await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }));
  } catch (_) {
    return null; // silent: needs interaction · interactive: user closed the window
  }
}

// Remember which Google account was used, so re-auth never shows the chooser again.
async function fetchDriveHint(token) {
  try {
    const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user/emailAddress",
      { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return;
    const j = await r.json();
    const email = j && j.user && j.user.emailAddress;
    if (email) await chrome.storage.sync.set({ driveHint: email });
  } catch (_) {}
}

async function getDriveToken() {
  const cached = await chrome.storage.session.get("driveToken").catch(() => ({}));
  const c = cached && cached.driveToken;
  if (c && c.token && c.exp > Date.now() + 60000) return c.token;

  const { clientId } = await getDriveSettings();
  if (!clientId) throw new Error("NO_CLIENT");
  const hintStore = await chrome.storage.sync.get("driveHint").catch(() => ({}));
  const hint = hintStore && hintStore.driveHint;
  let authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + encodeURIComponent(clientId) +
    "&response_type=token&redirect_uri=" + encodeURIComponent(chrome.identity.getRedirectURL()) +
    "&scope=" + encodeURIComponent(DRIVE_SCOPE);
  if (hint) authUrl += "&login_hint=" + encodeURIComponent(hint);

  // Silent refresh first (no window). Only prompt if silent needs interaction.
  let res = await launchAuth(authUrl, false);
  if (!res) res = await launchAuth(authUrl, true);
  if (!res) throw new Error("AUTH_CANCELLED");

  try { await chrome.storage.session.set({ driveToken: res }); } catch (_) {}
  if (!hint) fetchDriveHint(res.token); // fire-and-forget: store the account for next time
  return res.token;
}

function drivePost(token, filename, folderId, blob, mime) {
  const boundary = "fpc" + Math.random().toString(16).slice(2) + Date.now().toString(16); // all lowercase
  const metadata = { name: filename };
  if (folderId) metadata.parents = [folderId];
  const body = new Blob([
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
    JSON.stringify(metadata),
    "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n",
    blob,
    "\r\n--" + boundary + "--"
  ], { type: "multipart/related; boundary=" + boundary });
  return fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
    body
  });
}

function notifyDrive(title, message, id) {
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(id || "fpc-drive", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: title,
        message: message,
        priority: 2
      });
    }
  } catch (_) {}
}

const DRIVE_LABEL = "Click Me";
const DRIVE_ALIGNS = ["", "left", "center", "right"];   // "" = claim no alignment at all
const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A sheet takes its formatting from the HTML that was pasted, not from the cell it lands in.
// Whatever the HTML does not state, the importer fills in with ITS default - which is how a
// pasted link lands left (not centred), on the bottom of the row, at 10pt in a 12pt row. So the
// anchor travels inside a one-cell table that states those things, in both dialects a sheet
// reads: the align/valign attributes and the CSS. Google's own export of a sheet writes cells
// exactly this way, which is how the list of properties was chosen.
function linkHtml(url, label, align, size) {
  const a = '<a href="' + escHtml(url) + '">' + escHtml(label) + "</a>";
  if (!align && !size) return a;             // "as it comes": no table, no formatting claimed
  const css = [], attrs = [];
  if (align) { attrs.push('align="' + escHtml(align) + '"', 'valign="middle"');
               css.push("text-align:" + align, "vertical-align:middle"); }
  if (size) css.push("font-size:" + size + "pt");
  return "<table><tr><td " + attrs.join(" ") + (attrs.length ? " " : "") +
         'style="' + css.join(";") + '">' + a + "</td></tr></table>";
}

// The other way out of that whole argument: hand the sheet a formula instead of formatted HTML.
// A plain-text paste is just typing, so the cell keeps every bit of its own formatting - size,
// font, colour, alignment, the lot. The cost is that this is all a plain box (Teams, Notepad)
// gets too, so it is a deliberate choice, not the default.
function linkFormula(url, label) {
  const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';
  return "=HYPERLINK(" + q(url) + "," + q(label) + ")";
}

// Put the link on the clipboard. With a label set, it goes on TWICE: the plain URL as always,
// and the HTML beside it - so a paste into Google Sheets, Excel or Docs lands as one clickable
// word ("Click Me") the way the team's checklists are written, while a paste into a plain box
// (Teams, Notepad, a terminal) still gets the URL. Without a label, nothing changes.
async function putLinkOnClipboard(url, label, align, size, mode) {
  if (label && mode === "formula") {
    await navigator.clipboard.writeText(linkFormula(url, label));
    return "formula";
  }
  if (label && typeof ClipboardItem === "function" && navigator.clipboard && navigator.clipboard.write) {
    const html = linkHtml(url, label, align, size);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([url], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" })
      })]);
      return "label";
    } catch (_) { /* no rich clipboard here: the plain URL below is still worth having */ }
  }
  await navigator.clipboard.writeText(url);
  return "plain";
}
