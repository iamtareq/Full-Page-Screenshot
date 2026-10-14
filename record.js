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
let state = "idle";          // idle · micAsk · picking · counting · recording · stopped · uploading · uploaded
let myTabId = null;
let myWindowId = null;
let focusOnStop = true;      // false only when the stop was not the person's own doing
let cfg = { sys: true, mic: false, format: "webm", countdown: true, float: true };

let display = null;          // the stream Chrome's picker handed over
let micStream = null;
let mixer = null;            // { ctx, dest } when two sound sources are blended into one track
let audioCtx = null;         // one context for the blend AND the meters
let meters = null;           // { sys, mic } - an analyser on each source that is being recorded
let countTimer = null;
let countLeft = 0;
let pip = null;              // the floating timer, if it is up
let pipParts = null;         // its live bits, so the clock can be written straight into them
let pipRefused = false;      // the browser would not open it without a fresh click
let rec = null;
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
let lastDownloadId = null;   // so a rename can take the first file away again
let savedLocally = false;    // this recording has been put in Downloads, by the person asking for it
// Somewhere other than this tab: Downloads, or Drive. Until then the page says so and the browser
// asks before the tab closes.
const isKept = () => savedLocally || !!lastLink;
let driveAbort = null;
let stopWaiter = null;       // resolved by finish(), for the popup's "Update now"
let beat = null;             // keeps the toolbar's REC honest if this tab dies

// The recording goes to disk as it is made, so memory is no longer the limit - but a file this
// size is unwieldy to upload and to watch, so: a word at 500 MB, stop and save at 1.5 GB or an hour.
const WARN_BYTES = 500 * 1024 * 1024;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_MS = 60 * 60 * 1000;
// Chunked so the size counter is honest while recording. A `let` so a test can shorten it.
let TIMESLICE_MS = 1000;
let COUNT_FROM = 3;          // seconds between Share and the first frame; a `let` for the tests
const VIDEO_BPS = 4000000;   // ~30 MB a minute: 12px ERP text stays readable at 1080p
const AUDIO_BPS = 128000;

const SURFACE_WORDS = { monitor: "a whole screen", window: "one window", browser: "one tab" };

function setState(s) {
  state = s;
  document.body.dataset.state = s;
}

// The tab you left behind is the one you have to find again. Its title carries the clock, and
// its icon turns into a red dot, so a strip of fifteen tabs still shows which one is recording.
const PAGE_TITLE = "Screen recording \u2014 Full Page Capture";
let favWas = null;

function setTitle(ms) {
  document.title = ms == null ? PAGE_TITLE : "\u25cf " + mmss(ms) + " \u00b7 recording";
}

function setFavicon(on) {
  const link = el("fav");
  if (!link) return;
  if (!on) { if (favWas) link.href = favWas; return; }
  if (!favWas) favWas = link.getAttribute("href") || "icons/icon32.png";
  try {
    const c = document.createElement("canvas");
    c.width = 32; c.height = 32;
    const x = c.getContext("2d");
    x.fillStyle = "#dc2626";
    x.beginPath(); x.arc(16, 16, 13, 0, Math.PI * 2); x.fill();
    link.href = c.toDataURL("image/png");
  } catch (_) {}
}

/* ---- conditions: things that stay true for the whole recording ----
 * A toast fades after four seconds, usually while you are looking at the tab you are recording.
 * A silent microphone or a window with no sound is worth a line that stays. */
const conds = new Map();

function renderConds() {
  const box = el("conds");
  if (!box) return;
  const rows = [];
  conds.forEach((c) => {
    const d = document.createElement("div");
    d.className = "cond" + (c.warn ? " warn" : "");
    d.textContent = c.text;
    rows.push(d);
  });
  box.replaceChildren.apply(box, rows);
}

function cond(key, text, warn) {
  conds.set(key, { text, warn: !!warn });
  renderConds();
}

function clearConds() {
  conds.clear();
  renderConds();
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
  cfg.format = s.recFormat === "mp4" ? "mp4" : "webm";   // WebM unless asked otherwise: see pickMime
  cfg.countdown = s.recCountdown !== false;  // default on: the first ten recordings are worth it
  cfg.float = s.recFloat !== false;          // the little window that says it is still recording
  reflectSettings();
}

function reflectSettings() {
  const sys = el("togSys"), mic = el("togMic"), warn = el("fmtWarn");
  if (sys) sys.setAttribute("aria-pressed", cfg.sys ? "true" : "false");
  if (mic) mic.setAttribute("aria-pressed", cfg.mic ? "true" : "false");
  [["fmtWebm", "webm"], ["fmtMp4", "mp4"]].forEach(([id, fmt]) => {
    const b = el(id);
    if (b) b.setAttribute("aria-pressed", cfg.format === fmt ? "true" : "false");
  });
  // The MP4 warning belongs where MP4 is chosen, not three clicks away in Settings.
  if (warn) warn.hidden = cfg.format !== "mp4";
}

// These switches read from Settings, so they write back to the same place - one object, merged,
// because options.js rebuilds the whole thing from its form when it saves.
// One at a time, in order. Each write is a read-modify-write of the SAME settings object, so two
// switches pressed a moment apart both read the old object and the second drops the first - which
// is exactly what happened the first time two were pressed together in a real browser.
let settingsQueue = Promise.resolve();

function saveSetting(key, value) {
  settingsQueue = settingsQueue.then(async () => {
    const got = await chrome.storage.sync.get("settings");
    const next = Object.assign({}, (got && got.settings) || {});
    next[key] = value;
    await chrome.storage.sync.set({ settings: next });
  }).catch(() => {
    toast("That switch could not be saved \u2014 Settings still works");
  });
  return settingsQueue;
}

// Pressing one takes effect on the NEXT recording, with no reload: cfg is what startRecorder reads.
async function setSound(which, on) {
  if (which === "mic") {
    cfg.mic = on;
    await saveSetting("recMic", on);
    if (on) {
      const perm = await micPermission();
      if (perm === "denied") note("Chrome is blocking the microphone for this page. Unblock it in Chrome's site settings, or turn this back off.");
      else if (perm === "prompt") note("Chrome will ask to use the microphone when you press Start.");
      else note("");
    } else note("");
  } else {
    cfg.sys = on;
    await saveSetting("recSystemAudio", on);
  }
  reflectSettings();
}

async function setFormat(fmt) {
  cfg.format = fmt === "mp4" ? "mp4" : "webm";
  reflectSettings();
  await saveSetting("recFormat", cfg.format);
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
  clearConds();                         // a fresh attempt, so last time's news goes
  const perm = await micPermission();
  if (perm === "prompt") { setState("micAsk"); return; }
  if (perm === "denied") {
    cond("mic", "Chrome is blocking the microphone for this page, so this recording has no voice.", true);
  }
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
  cfg.mic = false;                      // this recording only; the switch in Settings is untouched
  reflectSettings();
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
      cond("mic", "The microphone could not be opened, so this recording has no voice.", true);
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
  // Chrome's own "Stop sharing" bar can be pressed during the count, not only while recording -
  // so this is listened for the moment the track exists, not when the recorder starts.
  const shared = display.getVideoTracks()[0];
  if (shared) shared.addEventListener("ended", onShareEnded);

  // Three seconds to get back to what you are recording, unless this person has turned it off.
  if (cfg.countdown) beginCountdown();
  else await startRecorder();
}

/* ------------------------------- the countdown -------------------------------
 * Chrome's picker closes on a click, and recording used to begin on that same click - so every
 * recording opened with a few seconds of the recorder tab while the person went to find the bug.
 * The capture is live during the count; it is simply not being recorded yet. */
function beginCountdown() {
  countLeft = COUNT_FROM;
  el("countNum").textContent = String(countLeft);
  setState("counting");
  clearInterval(countTimer);
  countTimer = setInterval(() => {
    countLeft--;
    if (countLeft > 0) { el("countNum").textContent = String(countLeft); return; }
    clearInterval(countTimer); countTimer = null;
    startRecorder();
  }, 1000);
}

// Sharing ended from Chrome's own bar. What that means depends on how far along we are.
function onShareEnded() {
  if (state === "counting") cancelCountdown("Sharing stopped — nothing was recorded");
  else if (state === "recording") requestStop();
}

function cancelCountdown(why) {
  clearInterval(countTimer); countTimer = null;
  stopEverything();                     // Chrome stops sharing: nothing was recorded, nothing kept
  setState("idle");
  toast(why || "Cancelled — nothing was recorded");
}

// For the person who records twenty a day: turn it off by pressing the thing in front of them.
function skipCountdown() {
  clearInterval(countTimer); countTimer = null;
  cfg.countdown = false;
  saveSetting("recCountdown", false);
  startRecorder();
}

// Chrome's muxer writes ONE audio track. With both sources on they have to be blended, or the
// file silently carries whichever track happened to come first.
// Wake the audio graph, and say so if it will not wake: silence that nobody explains is exactly
// what this page exists to prevent.
function wakeAudio() {
  const ctx = audioCtx;
  if (!ctx || !ctx.resume) return;
  Promise.resolve(ctx.resume()).then(() => {
    if (audioCtx === ctx && ctx.state === "suspended") {
      cond("audio", "The browser is holding this page's audio asleep, so the recording may have no sound.", true);
    }
  }).catch(() => {
    if (audioCtx === ctx) {
      cond("audio", "This page's audio could not be started, so the recording may have no sound.", true);
    }
  });
}

// An analyser on a source track, in a graph that is actually being pulled: an analyser hanging off
// nothing is never asked for data, so it would report a flat line whatever the microphone is doing.
function meterFor(ctx, track) {
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  an.smoothingTimeConstant = 0.4;
  src.connect(an);
  const silent = ctx.createGain();
  silent.gain.value = 0;                // nothing comes out of the speakers: this is only a tap
  an.connect(silent).connect(ctx.destination);
  // src and silent are returned, not dropped on the floor. A source node with no reference from
  // script has been collected mid-recording in Chrome before now, and the symptom is the worst
  // kind: the sound simply stops, minutes in, with nothing to show for it.
  return { an, src, silent, data: new Uint8Array(an.fftSize), seen: false };
}

function buildAudio() {
  const sys = display.getAudioTracks();
  const mic = micStream ? micStream.getAudioTracks() : [];
  if (sys.length || mic.length) {
    try { audioCtx = new AudioContext(); } catch (_) { audioCtx = null; }
    // A context made without a fresh click starts suspended, and the picker and the three-second
    // count have long since spent ours. A suspended context processes nothing at all: the blended
    // track would be silent and the meters would sit flat, both looking like a muted microphone.
    if (audioCtx && audioCtx.state === "suspended") wakeAudio();
    if (audioCtx) {
      meters = {};
      if (sys.length) meters.sys = meterFor(audioCtx, sys[0]);
      if (mic.length) meters.mic = meterFor(audioCtx, mic[0]);
    }
  }
  if (sys.length && mic.length) {
    try {
      const ctx = audioCtx || new AudioContext();
      audioCtx = ctx;
      const dest = ctx.createMediaStreamDestination();
      // Held for the same reason the meter's nodes are: an unreferenced source node has been
      // collected out from under a recording before.
      const sources = [sys[0], mic[0]].map((track) => {
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        src.connect(dest);
        return src;
      });
      mixer = { ctx, dest, sources };
      return { tracks: [dest.stream.getAudioTracks()[0]], words: "computer sound + microphone" };
    } catch (_) {
      return { tracks: [sys[0]], words: "computer sound (the two could not be blended)" };
    }
  }
  // sysMissing: the computer's sound was asked for and Chrome did not hand any over, which is
  // what happens for a single window. Worth saying out loud rather than leaving to be noticed.
  const sysMissing = cfg.sys && sys.length === 0;
  if (sys.length) return { tracks: [sys[0]], words: "computer sound", sysMissing: false };
  if (mic.length) return { tracks: [mic[0]], words: "microphone", sysMissing };
  return { tracks: [], words: cfg.sys ? "none — this surface offers no sound" : "none", sysMissing };
}

// WebM first, and deliberately. On 2026-10-14 Chrome 155's MP4 muxer killed this page's renderer
// twice on a real screen capture - MP4Status::kFailedToLookupSPS, i.e. it lost track of H.264's
// parameter sets coming out of the Intel hardware encoder - and an "Aw, Snap!" takes the recording
// with it. VP8/VP9 have no parameter sets, so that whole class of failure cannot happen. MP4 is
// still one switch away in Settings, for a file that has to go into Teams or WhatsApp.
const MIMES = {
  webm: {
    sound: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
    mute: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
  },
  mp4: {
    sound: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"],
    mute: ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
  }
};
function pickMime(withAudio) {
  const want = (MIMES[cfg.format] || MIMES.webm)[withAudio ? "sound" : "mute"];
  for (const m of want) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";                                  // let Chrome pick, and read it back from the recorder
}

/* ------------------- the recording on disk, not only in this tab -------------------
 * Every chunk goes straight into the origin's private file system (rec-store.js, in a worker,
 * flushing as it writes). Two things fall out of that: a renderer crash costs the last second
 * instead of the whole recording, and the finished file is read back as a disk-backed File, so
 * even a gigabyte never sits in this tab's memory. */
const STORE_SCRIPT = "rec-store.js";
let store = null;            // { worker, name } while a recording is being written
let storeSeq = 0;
const storeWaiting = new Map();
let memChunks = [];          // whatever could not go to disk - the fallback, and usually empty
let diskName = "";           // the OPFS file this recording is in

function storeCall(msg, transfer) {
  if (!store) return Promise.reject(new Error("NO_STORE"));
  const id = ++storeSeq;
  return new Promise((resolve, reject) => {
    storeWaiting.set(id, { resolve, reject });
    store.worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
}

async function storeOpen(name) {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error("NO_OPFS");
  const worker = new Worker(STORE_SCRIPT);
  worker.onmessage = (e) => {
    const w = storeWaiting.get(e.data.id);
    if (!w) return;
    storeWaiting.delete(e.data.id);
    e.data.ok ? w.resolve(e.data) : w.reject(new Error(e.data.error || "STORE_FAILED"));
  };
  worker.onerror = () => { storeWaiting.forEach((w) => w.reject(new Error("STORE_DIED"))); storeWaiting.clear(); };
  store = { worker, name };
  await storeCall({ op: "open", name });
  diskName = name;
}

// One chunk at a time, in order: the worker appends at a running offset, so two chunks whose
// arrayBuffer() happened to resolve out of order would scramble the file. A write that fails
// drops that chunk into memory instead, and the recording carries on either way.
let writeQueue = Promise.resolve();
function storeWrite(data) {
  if (!store) { memChunks.push(data); return; }
  writeQueue = writeQueue
    .then(() => data.arrayBuffer())
    .then((buf) => storeCall({ op: "write", buf }, [buf]))
    .catch(() => { memChunks.push(data); });   // disk went away mid-recording; keep the bytes
}

async function storeClose() {
  if (!store) return;
  try { await writeQueue; } catch (_) {}      // the last chunk is still on its way to the worker
  try { await storeCall({ op: "close" }); } catch (_) {}
  try { store.worker.terminate(); } catch (_) {}
  store = null;
}

// The finished recording, straight off disk - a File is a Blob, and nothing is copied into memory.
async function storeFile(name) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("fpc-rec", { create: false });
  const fh = await dir.getFileHandle(name, { create: false });
  return fh.getFile();
}

async function storeDrop(name) {
  if (!name) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("fpc-rec", { create: false });
    await dir.removeEntry(name);
  } catch (_) {}
}

// What the next page load reads to find out whether this tab died mid-recording.
async function mark(fields) {
  try {
    const got = await chrome.storage.local.get("fpcRec");
    await chrome.storage.local.set({ fpcRec: Object.assign({}, got.fpcRec, fields) });
  } catch (_) {}
}
async function forget() {
  try { await chrome.storage.local.remove("fpcRec"); } catch (_) {}
}

async function startRecorder() {
  clearInterval(countTimer); countTimer = null;
  const video = display.getVideoTracks()[0];
  if (!video) { stopEverything(); setState("idle"); toast("Chrome shared no picture \u2014 nothing to record"); return; }
  // Sharing may have been stopped while the count ran. Recording a track that has already ended
  // produces a file with nothing in it.
  if (video.readyState === "ended") {
    stopEverything();
    setState("idle");
    toast("Sharing stopped before recording began — nothing was recorded");
    return;
  }
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

  // Open the file BEFORE recording starts, so the very first chunk has somewhere to land. The
  // previous recording is already in Downloads, so its copy here has done its job.
  if (diskName) { storeDrop(diskName); diskName = ""; }
  dropPreview();
  blob = null;
  el("crashNote").hidden = true;
  el("crashBack").hidden = true;
  writeQueue = Promise.resolve();
  diskName = "rec-" + Date.now().toString(36) + (/mp4/.test(mime) ? ".mp4" : ".webm");
  try {
    await storeOpen(diskName);
  } catch (_) {
    store = null; diskName = "";
    cond("disk", "Held in this tab, not on disk. If the tab closes, this recording goes with it.", true);
  }

  memChunks = []; bytes = 0; stopping = false; warned = false;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) { bytes += e.data.size; storeWrite(e.data); } };
  rec.onstop = finish;
  rec.onerror = () => { toast("The recorder stopped with an error — saving what there is"); requestStop(); };

  try {
    rec.start(TIMESLICE_MS);
  } catch (e) {
    stopEverything();
    setState("idle");
    toast("The recorder refused to start: " + ((e && e.message) || "unknown error"));
    return;
  }
  startedAt = Date.now();
  mark({ name: diskName, mime: rec.mimeType || "", format: cfg.format, startedAt, state: "recording" });
  const s = video.getSettings ? video.getSettings() : {};
  // Read now, kept for the filename: by the time the file is named the track is stopped and
  // getSettings() has nothing left to say.
  lastSurface = s.displaySurface || "";
  el("factSurface").textContent = (SURFACE_WORDS[s.displaySurface] || "your screen") +
    (s.width && s.height ? " · " + s.width + "×" + s.height : "");
  el("factAudio").textContent = audio.words;
  el("rowSys").hidden = !(meters && meters.sys);
  el("rowMic").hidden = !(meters && meters.mic);
  // The words are for the case the meters cannot cover: no sound at all.
  el("rowSound").hidden = !!(meters && (meters.sys || meters.mic));
  // Chrome offers the computer's sound for a whole screen or a tab, never for a single window.
  if (audio.sysMissing) {
    cond("sys", "This surface offers no computer sound — Chrome only shares it for a whole screen or a tab.");
  }
  el("factFormat").textContent = (/mp4/.test(rec.mimeType || "") ? "MP4" : "WebM") +
    " · " + (rec.mimeType || "Chrome's default").replace(/;.*$/, "");
  el("bigWarn").hidden = true;
  setState("recording");
  setFavicon(true);
  openFloat();                          // the picker may have spent the click; the panel has a button
  onTick();
  ticker = setInterval(onTick, 250);
  announce(true);
  // A heartbeat, so a tab that dies without being closed cannot leave REC on the toolbar for ever.
  clearInterval(beat);
  beat = setInterval(() => announce(true), 10000);
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

// Five bars, from the loudest sample in the last frame. The point is not precision; it is the
// difference between "something is arriving" and "nothing has arrived since you started".
function drawMeter(box, level) {
  const bars = box.children || [];
  for (let i = 0; i < bars.length; i++) {
    const f = Math.max(0, Math.min(1, level * 1.4 - i * 0.18));
    bars[i].style.height = (2 + Math.round(f * 12)) + "px";
  }
}

function pumpMeters(ms) {
  if (!meters) return;
  [["sys", "meterSys", "wordSys"], ["mic", "meterMic", "wordMic"]].forEach(([key, boxId, wordId]) => {
    const m = meters[key];
    if (!m) return;
    const box = el(boxId), word = el(wordId);
    let peak = 0;
    try {
      m.an.getByteTimeDomainData(m.data);
      for (let i = 0; i < m.data.length; i += 4) {
        const v = Math.abs(m.data[i] - 128);
        if (v > peak) peak = v;
      }
    } catch (_) {}
    const level = Math.min(1, peak / 40);        // 40 of 128 is ordinary speech
    if (level > 0.08) m.seen = true;
    if (box) {
      drawMeter(box, level);
      box.classList.toggle("dead", !m.seen);
    }
    if (word) word.textContent = m.seen ? "arriving" : (ms > 2500 ? "silent since you started" : "listening…");
  });
}

function onTick() {
  const ms = Date.now() - startedAt;
  pumpMeters(ms);
  updateFloat(ms);
  el("clock").textContent = mmss(ms);
  setTitle(ms);
  el("size").textContent = mb(bytes);
  if (!warned && bytes >= WARN_BYTES) {
    warned = true;
    el("bigWarn").textContent = "This recording is over " + mb(WARN_BYTES) +
      ". It is safe on disk, but a file this big is slow to upload and to watch.";
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
  clearInterval(beat); beat = null;
  const mime = (rec && rec.mimeType) || "video/webm";
  stopEverything();
  announce(false);
  holdTab(false);
  setTitle(null);
  setFavicon(false);

  await storeClose();
  const type = mime.replace(/;.*$/, "");
  let onDisk = null;
  if (diskName) onDisk = await storeFile(diskName).catch(() => null);
  // Normally all of it is the one file on disk; memChunks only holds what a failed write caught.
  blob = onDisk && !memChunks.length ? onDisk
       : new Blob((onDisk ? [onDisk] : []).concat(memChunks), { type });
  memChunks = [];
  filename = recName(mime);
  lastLink = "";
  fillName();
  showPreview();
  setState("stopped");
  closeFloat();
  if (!blob.size) {
    el("savedLine").textContent = "Nothing was recorded — try again";
    if (stopWaiter) { const r = stopWaiter; stopWaiter = null; r(); }
    return;
  }
  // Nothing is written to this PC unless it is asked for: most recordings go straight to Drive,
  // and a Downloads folder full of files nobody wanted is its own problem. It stays on disk here
  // (and in the marker below) until it is sent or saved, so waiting costs nothing.
  savedLocally = false;
  lastDownloadId = null;
  reflectKept();
  mark({ state: "unsaved", filename, bytes: blob.size });
  // The recording is ready and nothing has been decided about it yet, so this is the moment the
  // tab is worth looking at.
  if (focusOnStop) showMe();
  focusOnStop = true;
  if (stopWaiter) { const r = stopWaiter; stopWaiter = null; r(); }
}

// The one line under the preview, and the two buttons' sense of urgency.
function reflectKept() {
  const line = el("savedLine");
  if (!line || !blob) return;
  const size = mb(blob.size);
  if (lastLink) line.textContent = "Sent to Drive ✓  ·  " + filename + "  ·  " + size;
  else if (savedLocally) line.textContent = "Saved to this PC ✓  ·  " + filename + "  ·  " + size;
  else line.textContent = "Ready  ·  " + size + "  ·  not saved anywhere yet";
  // Discarding something that was never kept should at least say that is what it does.
  const again = el("again");
  if (again) again.textContent = isKept() ? "Record another" : "Discard & record another";
}

function dropPreview() {
  if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (_) {} previewUrl = null; }
  el("preview").removeAttribute("src");
}

/* ------------------------------- the file's name -------------------------------
 * The name outlives the recording: it is what Downloads holds, what Drive shows, and what the
 * checklist's "Watch Me" points at six weeks later. So it is editable here, before it goes
 * anywhere - and editing it after the automatic save renames that file rather than leaving two. */
const nameParts = (full) => {
  const i = full.lastIndexOf(".");
  return i > 0 ? { stem: full.slice(0, i), ext: full.slice(i) } : { stem: full, ext: "" };
};

function fillName() {
  const box = el("nameBox"), ext = el("nameExt");
  if (!box) return;
  const p = nameParts(filename);
  box.value = p.stem;
  if (ext) ext.textContent = p.ext;
}

// Typing is not enough; this runs when the box is left or Enter is pressed.
async function commitName() {
  const box = el("nameBox");
  if (!box || !blob || !blob.size) return;
  const p = nameParts(filename);
  // Whatever is typed is a file name first: the same rules the rest of the extension uses, and
  // an extension typed by hand is dropped rather than doubled.
  let stem = sanitize(String(box.value || "").replace(/\.(webm|mp4)$/i, "").trim());
  if (!stem || stem === "screenshot") stem = p.stem;          // emptied: put the old name back
  box.value = stem;
  const next = stem + p.ext;
  if (next === filename) return;

  const wasId = lastDownloadId;
  const before = filename;
  filename = next;
  // Nothing has been written anywhere yet: renaming is just renaming.
  if (!savedLocally) {
    await mark({ filename });
    reflectKept();
    return;
  }
  try {
    lastDownloadId = await saveBlob(blob, filename, 10 * 60 * 1000);
    // One file, not two: the automatically saved one goes now that it has been replaced.
    if (wasId != null) {
      try { chrome.downloads.removeFile(wasId, () => void chrome.runtime.lastError); } catch (_) {}
      try { chrome.downloads.erase({ id: wasId }, () => void chrome.runtime.lastError); } catch (_) {}
    }
    reflectKept();                      // one place decides what that line says
    await mark({ state: "saved", filename, bytes: blob.size });
    toast("Renamed to " + filename);
  } catch (_) {
    filename = before;
    fillName();
    toast("Could not rename it — Downloads still has " + before);
  }
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
  mixer = null;
  meters = null;
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
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

/* ------------------------------- recovering a lost recording ------------------------------- */
// chrome.storage.local says whether the last recording ever reached a clean stop. If it did not,
// the bytes that made it to disk are still there - which is the whole reason they go to disk.
async function checkRecovery() {
  let r = null;
  try { r = (await chrome.storage.local.get("fpcRec")).fpcRec; } catch (_) {}
  if (!r || !r.name) return false;

  if (r.state !== "recording" && r.state !== "unsaved") {    // it was sent or saved: nothing owed
    await storeDrop(r.name);
    await forget();
    return false;
  }
  const crashed = r.state === "recording";
  const file = await storeFile(r.name).catch(() => null);
  if (!file || !file.size) {                  // nothing was written: nothing to recover
    await storeDrop(r.name);
    await forget();
    return false;
  }

  diskName = r.name;
  blob = file;
  filename = r.filename || recName(r.mime || "video/webm");
  fillName();
  showPreview();
  setState("stopped");
  // The same PC, the same Chrome, the same MP4 muxer: it will do it again. The recording is safe
  // either way, but the tab is not, so the format goes back to the one that cannot crash - and
  // anyone who wants to keep trying MP4 is one press away from it.
  let movedOff = false;
  if (crashed && r.format === "mp4" && cfg.format === "mp4") {
    cfg.format = "webm";
    reflectSettings();
    await saveSetting("recFormat", "webm");
    movedOff = true;
  }
  el("crashNote").textContent = crashed
    ? "This tab closed or crashed while it was recording" +
      (r.format === "mp4"
        ? " — Chrome's MP4 recorder does this on some PCs" + (movedOff ? ", so recording is back on WebM." : ".")
        : ".") +
      " Everything that had been written to disk is here."
    : "This recording was never sent or saved, so it is still here.";
  el("crashNote").hidden = false;
  el("crashBack").hidden = !movedOff;
  savedLocally = false;
  lastDownloadId = null;
  reflectKept();
  await mark({ state: "unsaved", filename, bytes: blob.size });
  return true;
}

/* ------------------------------- the floating timer -------------------------------
 * The thing being recorded is almost never this tab, and Chrome's own sharing bar can be
 * collapsed away - so there was nothing on screen saying a recording was running.
 *
 * It is a Document Picture-in-Picture window: it floats above every other window, including other
 * applications, and it is not in the taskbar, so it cannot be minimised out of sight. (An ordinary
 * popup window could be, which is what it replaced.) Nothing is injected into the page being
 * recorded - this extension still asks for no site access at all.
 *
 * One rule shapes the whole thing: requestWindow() CONSUMES the click that allowed it, and
 * getDisplayMedia needs that same click, so the timer can only be opened after Chrome's picker has
 * answered. When the browser refuses for want of a fresh click, the recording panel offers a
 * button instead.
 */
const FLOAT_W = 320, FLOAT_H = 186;   // Chrome trims ~56px off the height it is asked for

const FLOAT_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;
    background: #fff; color: #12151a; user-select: none;
    font: 13px/1.4 -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, Arial, sans-serif;
  }
  .top { display: flex; align-items: center; gap: 10px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #b42318; flex: 0 0 auto;
         animation: p 1.4s ease-in-out infinite; }
  @keyframes p { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
  .clock { font: 500 26px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
           letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
  .size { margin-left: auto; font-size: 12px; color: #5b6472; font-variant-numeric: tabular-nums; }
  .row { display: flex; gap: 8px; }
  button { height: 30px; padding: 0 12px; border-radius: 4px; border: 1px solid #8d95a1;
           background: #fff; color: #12151a; font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  .stop { flex: 1; background: #b42318; border-color: #b42318; color: #fff; }
  .note { margin: 0; font-size: 11px; line-height: 1.3; color: #5b6472; }
  @media (prefers-color-scheme: dark) {
    body { background: #16191d; color: #e6e9ec; }
    .size, .note { color: #9ba3ae; }
    button { background: #16191d; color: #e6e9ec; border-color: #646b75; }
    .stop { background: #fda29b; border-color: #fda29b; color: #2a0b08; }
    .dot { background: #fda29b; }
  }`;

// Built here rather than in a page of its own: a Picture-in-Picture window shares this page's
// script, so the clock is written straight into it with no messaging in between.
function buildFloatUI(doc) {
  const style = doc.createElement("style");
  style.textContent = FLOAT_CSS;
  doc.head.appendChild(style);

  const top = doc.createElement("div"); top.className = "top";
  const dot = doc.createElement("span"); dot.className = "dot";
  const clock = doc.createElement("span"); clock.className = "clock"; clock.textContent = "00:00";
  const size = doc.createElement("span"); size.className = "size"; size.textContent = "0.0 MB";
  top.appendChild(dot); top.appendChild(clock); top.appendChild(size);

  const row = doc.createElement("div"); row.className = "row";
  const stop = doc.createElement("button"); stop.className = "stop"; stop.textContent = "Stop recording";
  const hide = doc.createElement("button"); hide.textContent = "Hide";
  stop.addEventListener("click", () => { stop.disabled = true; stop.textContent = "Stopping…"; requestStop(); });
  hide.addEventListener("click", () => closeFloat());      // the recording carries on
  row.appendChild(stop); row.appendChild(hide);

  const note = doc.createElement("p"); note.className = "note";
  note.textContent = "";

  doc.body.appendChild(top); doc.body.appendChild(row); doc.body.appendChild(note);
  return { clock, size, note };
}

async function openFloat(fromClick) {
  if (!cfg.float || pip) return false;
  const api = typeof documentPictureInPicture === "object" ? documentPictureInPicture : null;
  if (!api || !api.requestWindow) { pipRefused = true; reflectFloatBtn(); return false; }
  try {
    pip = await api.requestWindow({ width: FLOAT_W, height: FLOAT_H, disallowReturnToOpener: true });
    pipParts = buildFloatUI(pip.document);
    pip.addEventListener("pagehide", () => { pip = null; pipParts = null; reflectFloatBtn(); });
    pipRefused = false;
    reflectFloatBtn();
    updateFloat(startedAt ? Date.now() - startedAt : 0);
    return true;
  } catch (_) {
    // Almost always "no transient activation": the click that started the recording was spent on
    // Chrome's own picker. The button in the panel is a fresh click, and that always works.
    pip = null; pipParts = null;
    pipRefused = true;
    if (fromClick) toast("Chrome would not open the floating timer");
    reflectFloatBtn();
    return false;
  }
}

function updateFloat(ms) {
  if (!pip || !pipParts) return;
  pipParts.clock.textContent = mmss(ms);
  pipParts.size.textContent = mb(bytes);
  // It is a window on the screen, so a whole-screen recording contains it. Say so once, quietly.
  pipParts.note.textContent = lastSurface === "monitor"
    ? "This window is in a whole-screen recording."
    : "";
}

function closeFloat() {
  if (!pip) return;
  try { pip.close(); } catch (_) {}
  pip = null; pipParts = null;
  reflectFloatBtn();
}

// The panel's own way back to it, for when the browser wanted a fresh click.
function reflectFloatBtn() {
  const b = el("showFloat");
  if (!b) return;
  b.hidden = !(cfg.float && state === "recording" && !pip);
}

/* ------------------------------- the tab, and the badge ------------------------------- */
function announce(on) {
  try { chrome.runtime.sendMessage({ type: "rec", on: !!on }); } catch (_) {}
}

// Stop is pressed from the floating timer, or from Chrome's own sharing bar, while the person is
// looking at something else entirely - and what happens next (send it to Drive, save it, name it)
// is on THIS tab. So bring it forward. Neither call needs a permission; the editor and the popup
// both already do exactly this.
async function showMe() {
  if (myTabId == null) return;
  try {
    const t = await chrome.tabs.update(myTabId, { active: true });
    const win = (t && t.windowId) != null ? t.windowId : myWindowId;
    if (win != null && chrome.windows && chrome.windows.update) {
      await chrome.windows.update(win, { focused: true });
    }
  } catch (_) {}
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
    const { folderId, shareAnyone, linkLabelVideo: linkLabel, linkAlign, linkSize, linkMode } = await getDriveSettings();
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
    await mark({ state: "saved", filename, bytes: blob.size });   // it is somewhere other than here now
    el("openDrive").href = lastLink;
    let copied = false;
    try { await putLinkOnClipboard(lastLink, linkLabel, linkAlign, linkSize, linkMode); copied = true; } catch (_) {}
    const vis = shareAnyone ? (sharedPublic ? "public link" : "private — sharing failed") : "private";
    line.textContent = (copied ? "Link copied ✓" : "Uploaded ✓ — copy the link below") +
      "  ·  " + vis + (up.rootFallback ? ", to your Drive root" : "");
    setState("uploaded");
    reflectKept();
    notifyDrive("Recording uploaded ✓",
      (copied ? "Link copied to clipboard — paste it anywhere." : "Uploaded — copy the link manually.") +
      " (" + vis + ")", "fpc-rec-drive");
  } catch (e) {
    const m = (e && e.message) || String(e);
    let msg;
    if (m === "NO_CLIENT") msg = "First set up Google Drive in Settings ⚙";
    else if (m === "UPLOAD_CANCELLED") msg = savedLocally
      ? "Upload cancelled — the file is still on this PC"
      : "Upload cancelled — the recording is still here, not sent anywhere";
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
    unexported: !!(blob && blob.size) && !isKept(),   // recorded, but not sent or saved yet
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
    focusOnStop = false;          // the person is in the popup pressing Update, not here
    requestStop();
    setTimeout(resolve, 20000);           // never hold the popup for ever
  });
}

/* ------------------------------- wiring ------------------------------- */
function resetToIdle() {
  clearConds();
  setTitle(null);
  dropPreview();
  if (diskName) { storeDrop(diskName); diskName = ""; }
  forget();
  blob = null; filename = ""; lastLink = ""; bytes = 0; lastDownloadId = null; savedLocally = false;
  el("nameBox").value = "";
  el("savedLine").textContent = "Saved to Downloads ✓";
  el("crashNote").hidden = true;
  el("crashBack").hidden = true;
  setState("idle");
  note("");
}

async function init() {
  // record.html ships data-state="idle" so the first paint is not a flash of every section at
  // once; this makes the script the one place the state actually lives.
  setState("idle");
  try {
    const t = await chrome.tabs.getCurrent();
    myTabId = t && t.id;
    myWindowId = t && t.windowId;
  } catch (_) {}
  await loadSettings();

  el("start").addEventListener("click", onStart);
  el("togSys").addEventListener("click", () => setSound("sys", !cfg.sys));
  el("togMic").addEventListener("click", () => setSound("mic", !cfg.mic));
  el("fmtWebm").addEventListener("click", () => setFormat("webm"));
  el("fmtMp4").addEventListener("click", () => setFormat("mp4"));
  el("micAllow").addEventListener("click", onMicAllow);
  el("micSkip").addEventListener("click", onMicSkip);
  el("stop").addEventListener("click", requestStop);
  el("countCancel").addEventListener("click", cancelCountdown);
  el("showFloat").addEventListener("click", () => openFloat(true));
  el("keepMp4").addEventListener("click", async () => {
    await setFormat("mp4");
    el("crashBack").hidden = true;
    toast("Back on MP4 — the recording still survives a crash, the tab does not");
  });
  el("countSkip").addEventListener("click", skipCountdown);
  el("again").addEventListener("click", () => { if (state !== "uploading") resetToIdle(); });
  const nameBox = el("nameBox");
  nameBox.addEventListener("change", commitName);
  nameBox.addEventListener("blur", commitName);
  nameBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameBox.blur(); } });
  // Typing replaces the whole name, and ignoring the field costs nothing.
  nameBox.addEventListener("focus", () => { try { nameBox.select(); } catch (_) {} });

  // The keyboard, but only while this page has focus - it never reaches the page being recorded.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state === "counting") { e.preventDefault(); cancelCountdown(); return; }
    if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button" ||
        tag === "video" || (t && t.isContentEditable)) return;      // let the control have it
    if (state === "recording") { e.preventDefault(); requestStop(); }
    else if (state === "idle" || state === "stopped" || state === "uploaded") { e.preventDefault(); onStart(); }
  });

  el("saveAgain").addEventListener("click", async () => {
    if (!blob || !blob.size) return;
    try {
      // chrome.downloads reads from the object URL while it writes, and a 600 MB file is still
      // writing long after a screenshot would be done: hold the URL for ten minutes, not one.
      lastDownloadId = await saveBlob(blob, filename, 10 * 60 * 1000);
      savedLocally = true;
      reflectKept();
      await mark({ state: "saved", filename, bytes: blob.size });
      toast("Saved to this PC · " + filename);
    } catch (_) { toast("Could not save it to this PC"); }
  });
  el("toDrive").addEventListener("click", sendToDrive);
  el("cancelUp").addEventListener("click", () => { if (driveAbort) driveAbort.abort(); });
  el("copyLink").addEventListener("click", async () => {
    if (!lastLink) return;
    try {
      const { linkLabelVideo: linkLabel, linkAlign, linkSize, linkMode } = await getDriveSettings();
      await putLinkOnClipboard(lastLink, linkLabel, linkAlign, linkSize, linkMode);
      toast(linkLabel ? "Link copied as “" + linkLabel + "”" : "Link copied");
    } catch (_) { toast("Could not copy — the link is on the Open in Drive button"); }
  });

  // Ctrl+W, a middle-click on the tab, or Chrome closing: a recording in flight is worth a
  // question. Everything else here is already on disk.
  window.addEventListener("beforeunload", (e) => {
    const unkept = !!(blob && blob.size) && !isKept();
    if (state !== "recording" && state !== "uploading" && !unkept) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  await checkRecovery();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || typeof MediaRecorder !== "function") {
    el("start").disabled = true;
    note("This browser cannot record a screen (no getDisplayMedia / MediaRecorder).");
  }
}

init();
