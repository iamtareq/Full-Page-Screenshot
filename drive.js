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

/* ------------------- Resumable upload: anything bigger than 5 MB ------------------- */
// drivePost above is one request, and Google documents uploadType=multipart for files of 5 MB or
// less. A screenshot never comes close; a long-page PDF can pass it, and a screen recording passes
// it in about sixteen seconds. So anything bigger goes up the resumable way: open a session once,
// then send the bytes in chunks that can be retried, resumed from where the server really got to,
// or cancelled.
const DRIVE_SIMPLE_MAX = 5 * 1024 * 1024;
// Every chunk but the last must be a multiple of 256 KiB. 8 MiB is a compromise: large enough that
// a 300 MB recording is ~40 requests, small enough that a dropped connection costs little.
const DRIVE_CHUNK = 8 * 1024 * 1024;
// How long to wait after the 1st, 2nd, 3rd... failure of one chunk. A let, so a test does not have
// to sleep fifteen real seconds to prove the backoff happens.
let DRIVE_BACKOFF = [1000, 2000, 4000, 8000];
// Up to three stale tokens in one upload: an hour-long upload can genuinely outlive two.
const DRIVE_MAX_REFRESH = 3;
const driveWait = (ms) => new Promise((r) => setTimeout(r, ms));

function driveAbortError() {
  const e = new Error("UPLOAD_CANCELLED");
  e.name = "AbortError";     // what the rest of the web calls a cancelled request
  return e;
}

// XMLHttpRequest, not fetch, and only on this path. Three things it needs that fetch cannot give:
// the session URI arrives in a response HEADER (Location), not in the body; a long upload has to
// say how far the REQUEST body has got, which fetch never reports; and Cancel has to stop bytes
// already in flight. An extension page may use XHR freely (a service worker may not - nothing
// here runs in one), and host_permissions means these responses are not CORS-filtered, so every
// header is readable.
function driveSend(o) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(o.method, o.url, true);
    const h = o.headers || {};
    Object.keys(h).forEach((k) => { if (h[k] != null) xhr.setRequestHeader(k, h[k]); });
    if (o.onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) o.onProgress(e.loaded, e.total); };
    }
    const sig = o.signal;
    const kill = () => xhr.abort();
    const off = () => { if (sig) sig.removeEventListener("abort", kill); };
    if (sig) {
      if (sig.aborted) { reject(driveAbortError()); return; }
      sig.addEventListener("abort", kill);
    }
    xhr.onload = () => {
      off();
      resolve({
        status: xhr.status,
        text: xhr.responseText || "",
        header: (n) => xhr.getResponseHeader(n),
        json() { try { return JSON.parse(this.text); } catch (_) { return null; } }
      });
    };
    // No status at all: offline, DNS, or the connection dropped. Told apart from an HTTP error
    // because it is the one case where the server may still have kept part of the chunk.
    xhr.onerror = () => { off(); reject(new Error("NETWORK")); };
    xhr.ontimeout = () => { off(); reject(new Error("NETWORK")); };
    xhr.onabort = () => { off(); reject(driveAbortError()); };
    xhr.send(o.body === undefined ? null : o.body);
  });
}

// A token that went stale mid-upload: drop the cached one and let getDriveToken fetch another,
// silently in the ordinary case. The session URI itself does not depend on the token.
async function driveRefreshToken() {
  try { await chrome.storage.session.remove("driveToken"); } catch (_) {}
  return getDriveToken();
}

// Open a session. The reply carries no file: its only payload is the Location header, the URI the
// chunks go to. That URI lives about a week and is independent of the token.
function driveSession(token, filename, folderId, blob, mime, signal) {
  const meta = { name: filename };
  if (folderId) meta.parents = [folderId];
  return driveSend({
    method: "POST",
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(blob.size)
    },
    body: JSON.stringify(meta),
    signal
  });
}

// Ask the server how much it actually holds. Used after anything goes wrong, because our own
// count of what we sent is a guess: a chunk can be half received.
function driveQuery(uri, total, token, signal) {
  return driveSend({
    method: "PUT",
    url: uri,
    headers: { Authorization: "Bearer " + token, "Content-Range": "bytes */" + total },
    signal
  });
}

// "bytes=0-262143" -> 262144, where the next chunk starts. A 308 with no Range means the server
// is holding nothing yet.
function driveNextFrom(range) {
  const m = /bytes=(\d+)-(\d+)/.exec(String(range || ""));
  return m ? parseInt(m[2], 10) + 1 : 0;
}

// Send the bytes. Every decision about where we are comes from the server's Range header, never
// from adding up what we believe we sent.
async function drivePutChunks(uri, blob, token, onProgress, signal) {
  const total = blob.size;
  if (!total) throw new Error("EMPTY_FILE");
  let sent = 0, fails = 0, refreshes = 0;
  if (onProgress) onProgress(0, total);
  for (;;) {
    const end = Math.min(sent + DRIVE_CHUNK, total);
    const at = sent;                       // onProgress reports absolute bytes, chunks are relative
    let r = null;
    try {
      r = await driveSend({
        method: "PUT",
        url: uri,
        headers: { Authorization: "Bearer " + token,
                   "Content-Range": "bytes " + sent + "-" + (end - 1) + "/" + total },
        body: blob.slice(sent, end),
        onProgress: onProgress && ((loaded) => onProgress(Math.min(at + loaded, total), total)),
        signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      r = null;                            // dropped: fall through to the backoff below
    }

    if (r && (r.status === 200 || r.status === 201)) {
      const file = r.json();
      if (!file || !file.id) throw new Error("NO_FILE_ID");
      if (onProgress) onProgress(total, total);
      return { file, token };
    }

    let moved = false;
    if (r && r.status === 308) {
      const next = driveNextFrom(r.header("Range"));
      if (next > sent) { sent = next; fails = 0; moved = true; if (onProgress) onProgress(sent, total); }
      // A 308 that did not move is a failure to retry, not progress - do not spin on it.
    }
    if (moved) continue;

    if (r && r.status === 401 && refreshes < DRIVE_MAX_REFRESH) {
      refreshes++;
      token = await driveRefreshToken();
      continue;                            // the same chunk again, with the new token, no waiting
    }
    if (r && r.status === 404) throw new Error("SESSION_GONE");
    // 400, 403, a second 401...: retrying cannot help.
    if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      throw new Error("HTTP " + r.status + " " + r.text.slice(0, 120));
    }

    // 5xx, 429, 408, a dropped connection, or a stuck 308: wait, then ask where the server
    // really got to before sending another byte.
    if (fails >= DRIVE_BACKOFF.length) throw new Error("UPLOAD_STALLED");
    await driveWait(DRIVE_BACKOFF[fails++]);
    if (signal && signal.aborted) throw driveAbortError();
    let q = null;
    try { q = await driveQuery(uri, total, token, signal); } catch (e) {
      if (e && e.name === "AbortError") throw e;
    }
    if (!q) continue;
    if (q.status === 200 || q.status === 201) {
      const file = q.json();               // it had finished after all
      if (file && file.id) { if (onProgress) onProgress(total, total); return { file, token }; }
      continue;
    }
    if (q.status === 404) throw new Error("SESSION_GONE");
    if (q.status === 401 && refreshes < DRIVE_MAX_REFRESH) { refreshes++; token = await driveRefreshToken(); continue; }
    if (q.status === 308) {
      const next = driveNextFrom(q.header("Range"));
      if (next !== sent) { sent = next; fails = 0; }
      if (onProgress) onProgress(sent, total);
    }
  }
}

// One door in front of both paths. Returns { file, rootFallback, token } - the token comes back
// because it may have been refreshed along the way, and the caller still needs a live one to
// share the file afterwards.
//   onProgress(sentBytes, totalBytes), signal: an AbortSignal for Cancel.
async function driveUpload(token, filename, folderId, blob, mime, opts) {
  opts = opts || {};
  const onProgress = opts.onProgress, signal = opts.signal;
  if (signal && signal.aborted) throw driveAbortError();

  // Small: exactly the one request this extension has always made.
  if (blob.size <= DRIVE_SIMPLE_MAX) {
    let res = await drivePost(token, filename, folderId, blob, mime);
    if (res.status === 401) {              // token went stale - refresh once
      token = await driveRefreshToken();
      res = await drivePost(token, filename, folderId, blob, mime);
    }
    let rootFallback = false;
    if ((res.status === 404 || res.status === 403) && folderId) {
      // Folder not writable (wrong id / no access) -> upload to Drive root instead.
      res = await drivePost(token, filename, "", blob, mime);
      rootFallback = res.ok;
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 120));
    if (onProgress) onProgress(blob.size, blob.size);
    return { file: await res.json(), rootFallback, token };
  }

  // Big. The folder is settled before any bytes move: the session POST is cheap, so a folder we
  // cannot write to costs one request here instead of a whole upload there.
  let rootFallback = false;
  let s = await driveSession(token, filename, folderId, blob, mime, signal);
  if (s.status === 401) {
    token = await driveRefreshToken();
    s = await driveSession(token, filename, folderId, blob, mime, signal);
  }
  if ((s.status === 404 || s.status === 403) && folderId) {
    s = await driveSession(token, filename, "", blob, mime, signal);
    rootFallback = s.status >= 200 && s.status < 300;
  }
  if (s.status < 200 || s.status >= 300) throw new Error("HTTP " + s.status + " " + s.text.slice(0, 120));
  const uri = s.header("Location");
  if (!uri) throw new Error("NO_SESSION_URI");

  const done = await drivePutChunks(uri, blob, token, onProgress, signal);
  return { file: done.file, rootFallback, token: done.token };
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
