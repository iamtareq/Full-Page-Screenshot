/* Full Page Capture — the screen recorder.
 *
 * A tab, not the popup: getDisplayMedia needs a user gesture, and the popup closes the moment
 * Chrome's picker takes focus, which would cancel the very thing it asked for. Nothing here is
 * injected into a web page - the recording is Chrome's own picker, Chrome's own "Stop sharing"
 * bar, and this page.
 *
 * It shares common.js (saveBlob) and drive.js (the whole Drive transport) with the editor, so a
 * recording's link pastes into the team's checklist sheets exactly like a screenshot's.
 */

const el = (id) => document.getElementById(id);

/* ------------------------------- state ------------------------------- */
let state = "idle";          // idle · micAsk · picking · recording · stopped · uploading · uploaded
let myTabId = null;
let cfg = { sys: true, mic: false };

let display = null;          // the stream Chrome's picker handed over
let micStream = null;
let mixer = null;            // { ctx, dest } when two sound sources are blended into one track
let rec = null;
let chunks = [];
let bytes = 0;
let startedAt = 0;
let ticker = null;
let stopping = false;
let warned = false;

let blob = null;
let filename = "";
let previewUrl = null;
let lastLink = "";
let lastSurface = "";        // monitor · window · browser, read while the track is still alive
let driveAbort = null;
let stopWaiter = null;       // resolved by finish(), for the popup's "Update now"

// A recording is held in memory until it stops, so there is a ceiling. A saved big file beats a
// crashed tab: warn at 500 MB, stop and save at 1.5 GB or an hour.
const WARN_BYTES = 500 * 1024 * 1024;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_MS = 60 * 60 * 1000;
// Chunked so the size counter is honest while recording. A `let` so a test can shorten it.
let TIMESLICE_MS = 1000;
const VIDEO_BPS = 4000000;   // ~30 MB a minute: 12px ERP text stays readable at 1080p
const AUDIO_BPS = 128000;

const SURFACE_WORDS = { monitor: "a whole screen", window: "one window", browser: "one tab" };

function setState(s) {
  state = s;
  document.body.dataset.state = s;
}

let toastTimer = null;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

function note(msg) {
  const n = el("idleNote");
  n.textContent = msg || "";
  n.hidden = !msg;
}

/* ------------------------------- settings ------------------------------- */
async function loadSettings() {
  let s = {};
  try { s = (await chrome.storage.sync.get("settings")).settings || {}; } catch (_) {}
  cfg.sys = s.recSystemAudio !== false;      // default on
  cfg.mic = s.recMic === true;               // default off
  const sys = el("chipSys"), mic = el("chipMic");
  sys.dataset.on = cfg.sys ? "1" : "0";
  mic.dataset.on = cfg.mic ? "1" : "0";
  sys.textContent = cfg.sys ? "Computer sound: on" : "Computer sound: off";
  mic.textContent = cfg.mic ? "Microphone: on" : "Microphone: off";
}

// "off" when the switch is off, otherwise what Chrome says about this page's permission.
async function micPermission() {
  if (!cfg.mic) return "off";
  try {
    const p = await navigator.permissions.query({ name: "microphone" });
    return p.state;                           // granted · prompt · denied
  } catch (_) {
    return "prompt";                          // no Permissions API for it: ask, and find out
  }
}

/* ------------------------------- starting ------------------------------- */
async function onStart() {
  if (state !== "idle" && state !== "stopped" && state !== "uploaded") return;
  note("");
  // Only a quick permission read before the picker: an await of the microphone PROMPT would
  // outlive the click that getDisplayMedia needs, which is why that lives on its own screen.
  const perm = await micPermission();
  if (perm === "prompt") { setState("micAsk"); return; }
  if (perm === "denied") toast("Chrome is blocking the microphone for this page — recording without a voice");
  await begin(perm === "granted");
}

async function onMicAllow() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());   // this was only the question, not the recording
    setState("idle");
    note("Microphone allowed ✓ · press Start recording.");
  } catch (_) {
    setState("idle");
    note("The microphone was not allowed. The recording will have no voice — or turn it off in Settings.");
  }
}

function onMicSkip() {
  cfg.mic = false;
  el("chipMic").dataset.on = "0";
  el("chipMic").textContent = "Microphone: off";
  setState("idle");
  begin(false);
}

async function begin(withMic) {
  setState("picking");
  micStream = null;
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      toast("The microphone could not be opened — recording without it");
    }
  }
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      // Computer sound is only offered for a screen or a tab, never for a single window - the
      // recording says which sound actually arrived rather than which was asked for.
      audio: cfg.sys
    });
  } catch (e) {
    stopTracks(micStream); micStream = null;
    setState(blob ? "stopped" : "idle");
    const name = (e && e.name) || "";
    toast(name === "NotAllowedError" ? "Nothing shared — nothing recorded"
         : "Could not start: " + ((e && e.message) || name || "unknown error"));
    return;
  }
  startRecorder();
}

// Chrome's muxer writes ONE audio track. With both sources on they have to be blended, or the
// file silently carries whichever track happened to come first.
function buildAudio() {
  const sys = display.getAudioTracks();
  const mic = micStream ? micStream.getAudioTracks() : [];
  if (sys.length && mic.length) {
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      [sys[0], mic[0]].forEach((track) => {
        ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
      });
      mixer = { ctx, dest };
      return { tracks: [dest.stream.getAudioTracks()[0]], words: "computer sound + microphone" };
    } catch (_) {
      return { tracks: [sys[0]], words: "computer sound (the two could not be blended)" };
    }
  }
  if (sys.length) return { tracks: [sys[0]], words: "computer sound" };
  if (mic.length) return { tracks: [mic[0]], words: "microphone" };
  return { tracks: [], words: cfg.sys ? "none — this surface offers no sound" : "none" };
}

function pickMime(withAudio) {
  const want = withAudio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  for (const m of want) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";                                  // let Chrome pick, and read it back from the recorder
}

function startRecorder() {
  const video = display.getVideoTracks()[0];
  if (!video) { stopEverything(); setState("idle"); toast("Chrome shared no picture \u2014 nothing to record"); return; }
  const audio = buildAudio();
  const out = new MediaStream([video].concat(audio.tracks));
  const mime = pickMime(audio.tracks.length > 0);
  const opts = { videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS };
  if (mime) opts.mimeType = mime;
  try {
    rec = new MediaRecorder(out, opts);
  } catch (_) {
    try { rec = new MediaRecorder(out); } catch (e2) {
      stopEverything();
      setState("idle");
      toast("This Chrome cannot record: " + ((e2 && e2.message) || "MediaRecorder refused the stream"));
      return;
    }
  }

  chunks = []; bytes = 0; stopping = false; warned = false;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); bytes += e.data.size; } };
  rec.onstop = finish;
  rec.onerror = () => { toast("The recorder stopped with an error — saving what there is"); requestStop(); };
  // Chrome's own "Stop sharing" bar ends the track, not the recorder. Without this the recording
  // would keep running against a dead track and the file would be lost.
  video.addEventListener("ended", () => requestStop());

  try {
    rec.start(TIMESLICE_MS);
  } catch (e) {
    stopEverything();
    setState("idle");
    toast("The recorder refused to start: " + ((e && e.message) || "unknown error"));
    return;
  }
  startedAt = Date.now();
  const s = video.getSettings ? video.getSettings() : {};
  // Read now, kept for the filename: by the time the file is named the track is stopped and
  // getSettings() has nothing left to say.
  lastSurface = s.displaySurface || "";
  el("factSurface").textContent = (SURFACE_WORDS[s.displaySurface] || "your screen") +
    (s.width && s.height ? " · " + s.width + "×" + s.height : "");
  el("factAudio").textContent = audio.words;
  el("factFormat").textContent = (/mp4/.test(rec.mimeType || "") ? "MP4" : "WebM") +
    " · " + (rec.mimeType || "Chrome's default").replace(/;.*$/, "");
  el("bigWarn").hidden = true;
  setState("recording");
  onTick();
  ticker = setInterval(onTick, 250);
  announce(true);
  holdTab(true);
}

/* ------------------------------- while recording ------------------------------- */
const mmss = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  return (h ? h + ":" + pad(Math.floor(t / 60) % 60) : String(Math.floor(t / 60)).padStart(2, "0")) +
         ":" + pad(t % 60);
};
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

function onTick() {
  const ms = Date.now() - startedAt;
  el("clock").textContent = mmss(ms);
  el("size").textContent = mb(bytes);
  if (!warned && bytes >= WARN_BYTES) {
    warned = true;
    el("bigWarn").textContent = "This recording is over " + mb(WARN_BYTES) +
      ". It is held in this tab until it stops, so stop soon rather than losing it.";
    el("bigWarn").hidden = false;
  }
  if (bytes >= MAX_BYTES || ms >= MAX_MS) {
    toast(bytes >= MAX_BYTES ? "Stopped at 1.5 GB and saved — a saved file beats a crashed tab"
                             : "Stopped at an hour and saved");
    requestStop();
  }
}

// Every way of stopping comes through here: the button, Chrome's Stop-sharing bar, a recorder
// error, and the two ceilings. rec.onstop is the only place that finalises.
function requestStop() {
  if (stopping) return;
  stopping = true;
  if (!rec || rec.state === "inactive") { finish(); return; }
  try { rec.stop(); } catch (_) { finish(); }
}

async function finish() {
  clearInterval(ticker); ticker = null;
  const mime = (rec && rec.mimeType) || "video/webm";
  stopEverything();
  announce(false);
  holdTab(false);

  blob = new Blob(chunks, { type: mime.replace(/;.*$/, "") });
  chunks = [];
  filename = recName(mime);
  lastLink = "";
  showPreview();
  setState("stopped");
  if (!blob.size) {
    el("savedLine").textContent = "Nothing was recorded — try again";
    if (stopWaiter) { const r = stopWaiter; stopWaiter = null; r(); }
    return;
  }
  // chrome.downloads reads from the object URL while it writes, and a 600 MB file is still
  // writing long after a screenshot would be done: hold the URL for ten minutes, not one.
  try {
    await saveBlob(blob, filename, 10 * 60 * 1000);
    el("savedLine").textContent = "Saved to Downloads ✓  ·  " + filename + "  ·  " + mb(blob.size);
  } catch (_) {
    el("savedLine").textContent = "Could not save it automatically — press Save again";
  }
  if (stopWaiter) { const r = stopWaiter; stopWaiter = null; r(); }
}

function showPreview() {
  const v = el("preview");
  if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (_) {} previewUrl = null; }
  if (!blob || !blob.size) { v.removeAttribute("src"); return; }
  previewUrl = URL.createObjectURL(blob);
  v.src = previewUrl;
}

function stopTracks(s) {
  if (!s) return;
  try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
}

function stopEverything() {
  stopTracks(display); display = null;
  stopTracks(micStream); micStream = null;
  if (mixer) {
    try { mixer.ctx.close(); } catch (_) {}
    mixer = null;
  }
}

// recording-screen-2026-10-14-143207.mp4 — the editor's buildFilename is not reused: it reads
// editor state (page title, URL, join counts) that a recording has none of.
function recName(mime) {
  const d = new Date();
  const kind = { monitor: "screen", window: "window", browser: "tab" }[lastSurface] || "screen";
  return "recording-" + kind + "-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
    "." + (/mp4/.test(mime) ? "mp4" : "webm");
}

/* ------------------------------- the tab, and the badge ------------------------------- */
function announce(on) {
  try { chrome.runtime.sendMessage({ type: "rec", on: !!on }); } catch (_) {}
}

// A background tab can be discarded by Chrome to save memory, which would take the recording
// with it. The editor does the same while a capture is in flight.
function holdTab(on) {
  if (myTabId == null) return;
  try { chrome.tabs.update(myTabId, { autoDiscardable: !on }); } catch (_) {}
}

/* ------------------------------- Drive ------------------------------- */
async function sendToDrive() {
  if (!blob || !blob.size || state === "uploading") return;
  const line = el("linkLine");
  driveAbort = new AbortController();
  setState("uploading");
  setProgress(0, 1);
  try {
    const { folderId, shareAnyone, linkLabel, linkAlign, linkSize, linkMode } = await getDriveSettings();
    let token = await getDriveToken();
    const up = await driveUpload(token, filename, folderId, blob, blob.type || "video/mp4",
      { onProgress: setProgress, signal: driveAbort.signal });
    token = up.token;

    let sharedPublic = false;
    if (shareAnyone) {
      try {
        const pr = await fetch("https://www.googleapis.com/drive/v3/files/" + up.file.id + "/permissions", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ role: "reader", type: "anyone" })
        });
        sharedPublic = pr.ok;
      } catch (_) {}
    }

    lastLink = up.file.webViewLink || ("https://drive.google.com/file/d/" + up.file.id + "/view");
    el("openDrive").href = lastLink;
    let copied = false;
    try { await putLinkOnClipboard(lastLink, linkLabel, linkAlign, linkSize, linkMode); copied = true; } catch (_) {}
    const vis = shareAnyone ? (sharedPublic ? "public link" : "private — sharing failed") : "private";
    line.textContent = (copied ? "Link copied ✓" : "Uploaded ✓ — copy the link below") +
      "  ·  " + vis + (up.rootFallback ? ", to your Drive root" : "");
    setState("uploaded");
    notifyDrive("Recording uploaded ✓",
      (copied ? "Link copied to clipboard — paste it anywhere." : "Uploaded — copy the link manually.") +
      " (" + vis + ")", "fpc-rec-drive");
  } catch (e) {
    const m = (e && e.message) || String(e);
    let msg;
    if (m === "NO_CLIENT") msg = "First set up Google Drive in Settings ⚙";
    else if (m === "UPLOAD_CANCELLED") msg = "Upload cancelled — the file is still in Downloads";
    else if (/CANCELLED/.test(m)) msg = "Drive sign-in cancelled";
    else if (m === "UPLOAD_STALLED") msg = "Upload stopped — the connection kept dropping. Try again.";
    else if (m === "SESSION_GONE" || m === "NO_SESSION_URI") msg = "Drive dropped the upload — try again";
    else msg = "Drive upload failed: " + m.slice(0, 90);
    toast(msg);
    setState(lastLink ? "uploaded" : "stopped");
    if (!/CANCELLED|NO_CLIENT/.test(m)) notifyDrive("Recording upload failed", msg, "fpc-rec-drive");
  } finally {
    driveAbort = null;
  }
}

function setProgress(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  el("barFill").style.width = pct + "%";
  el("upPct").textContent = pct + "%";
}

/* ------------------------------- the popup's "Update now" ------------------------------- */
// Read by the popup before chrome.runtime.reload() closes every page of this extension. The
// shape is the editor's, so popup.js needs no second code path: a recording in progress reads
// as "capturing", which is what makes the popup warn about it.
function fpcEditorState() {
  return {
    title: state === "recording" ? "Screen recording · " + mmss(Date.now() - startedAt)
         : blob && blob.size ? "Screen recording · " + mb(blob.size) : "Screen recording",
    capturing: state === "recording" || state === "uploading",
    failed: false,
    hasImage: !!(blob && blob.size) || state === "recording",
    marks: 0,
    unsavedMarks: false,
    unexported: false,                    // it saves itself the moment it stops
    inRecent: false,
    recentId: null,
    tabId: myTabId,
    recording: state === "recording"
  };
}
// Stop and save before the extension reloads: the popup waits on this promise. Losing a
// recording to an update it did not know about would be the worst thing this page could do.
function fpcBeforeReload() {
  if (state !== "recording") return Promise.resolve();
  return new Promise((resolve) => {
    stopWaiter = resolve;
    requestStop();
    setTimeout(resolve, 20000);           // never hold the popup for ever
  });
}

/* ------------------------------- wiring ------------------------------- */
function resetToIdle() {
  if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (_) {} previewUrl = null; }
  el("preview").removeAttribute("src");
  blob = null; filename = ""; lastLink = ""; bytes = 0;
  el("savedLine").textContent = "Saved to Downloads ✓";
  setState("idle");
  note("");
}

async function init() {
  // record.html ships data-state="idle" so the first paint is not a flash of every section at
  // once; this makes the script the one place the state actually lives.
  setState("idle");
  try { const t = await chrome.tabs.getCurrent(); myTabId = t && t.id; } catch (_) {}
  await loadSettings();

  el("start").addEventListener("click", onStart);
  el("micAllow").addEventListener("click", onMicAllow);
  el("micSkip").addEventListener("click", onMicSkip);
  el("stop").addEventListener("click", requestStop);
  el("again").addEventListener("click", () => { if (state !== "uploading") resetToIdle(); });
  el("saveAgain").addEventListener("click", async () => {
    if (!blob || !blob.size) return;
    try { await saveBlob(blob, filename, 10 * 60 * 1000); toast("Saved again · " + filename); }
    catch (_) { toast("Could not save it"); }
  });
  el("toDrive").addEventListener("click", sendToDrive);
  el("cancelUp").addEventListener("click", () => { if (driveAbort) driveAbort.abort(); });
  el("copyLink").addEventListener("click", async () => {
    if (!lastLink) return;
    try {
      const { linkLabel, linkAlign, linkSize, linkMode } = await getDriveSettings();
      await putLinkOnClipboard(lastLink, linkLabel, linkAlign, linkSize, linkMode);
      toast(linkLabel ? "Link copied as “" + linkLabel + "”" : "Link copied");
    } catch (_) { toast("Could not copy — the link is on the Open in Drive button"); }
  });

  // Ctrl+W, a middle-click on the tab, or Chrome closing: a recording in flight is worth a
  // question. Everything else here is already on disk.
  window.addEventListener("beforeunload", (e) => {
    if (state !== "recording" && state !== "uploading") return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || typeof MediaRecorder !== "function") {
    el("start").disabled = true;
    note("This browser cannot record a screen (no getDisplayMedia / MediaRecorder).");
  }
}

init();
