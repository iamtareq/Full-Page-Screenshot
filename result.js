/* Full Page Capture — result / editor page
 * Receives capture tiles from the background service worker over a port,
 * stitches them onto one or more canvases, and provides export tools.
 */

const MAX_SIDE = 32000;          // hard canvas dimension guard
const MAX_AREA = 256000000;      // ~16k x 16k area guard
const HARD_SEG_HEIGHT = 16000;   // preferred max segment height (device px)

const params = new URLSearchParams(location.search);
const jobId = params.get("job");

const el = (id) => document.getElementById(id);
const stage = el("stage");
const canvasHost = el("canvasHost");
const progressWrap = el("progressWrap");
const progressFill = el("progressFill");
const progressSub = el("progressSub");
const progressTitle = el("progressTitle");
const errorWrap = el("errorWrap");
const errorMsg = el("errorMsg");
const tools = el("tools");
const cropOverlay = el("cropOverlay");
const cropRect = el("cropRect");
const cropBar = el("cropbar");

let meta = null;
let dpr = 1;
let cropWpx = 0, cropHpx = 0, fullWpx = 0, fullHpx = 0;
let segments = [];           // { canvas, ctx, startY, height }
let received = 0, expected = 0;
let zoom = null;             // null => fit-to-width
let currentFormat = "png";
let quality = 0.92;
let defaultSettings = { format: "png", jpegQuality: 0.92, filenameTemplate: "{title}-{date}", infoBar: true, envBar: true };
let aborted = false;         // set once an unrecoverable error is shown
let truncated = false;       // page was wider than the canvas limit
let sectionCount = 0;        // scroll passes this capture was stitched from
let wasCropped = false;      // the image on screen is a crop of the capture
let scrollbarLeft = false;   // vertical scrollbar rendered on the left (RTL)
let infoBar = true;          // stamp a URL + capture-time bar on top of the image
let envBar = true;           // include a 2nd line with Browser/OS/Viewport/DPR
let baseSeg0 = null;         // pristine top segment (without the info bar)
let stampLocked = false;     // info-bar toggle frozen after crop / annotate
let tileChain = Promise.resolve(); // serializes async tile draws; finalize waits on it
let infoBarLink = null;      // {x,y,w,h,uri} device px of the URL text (for PDF links)
let lastDriveLink = null;    // last uploaded Drive link (for the notification click)
let stampTime = null;        // the capture's own moment, frozen once: every bar redraw prints the SAME time
let captureTime = null;      // set when an older capture is restored, so the info bar keeps ITS time
let captureSettled = false;
let recentEnabled = false;   // Settings > "Keep recent captures" - opt-in, off until enabled
let currentRecentId = null;  // the Recent row this editor writes its annotations back into
let recentSaveTimer = null;  // true once the job finished (or failed); restoring a Recent capture before that would let late tiles paint over it
// Work protection - see "Work protection" below.
let exportedClean = false;   // true right after a Download / Copy / Drive send; any edit clears it
let bakedMarks = false;      // a Crop flattened marks into the pixels, so annotations[] no longer shows them
let myTabId = null;          // this editor's own tab id (chrome.tabs.getCurrent - needs no permission)
let discardGuardOn = null;   // the autoDiscardable state last asked for (null = never asked)
let recentJobChecked = false; // saveRecent looked for an existing row of this job once

// Annotation state (single-segment images only)
let annotCanvas = null, annotCtx = null;
let annotating = false;
let annotTool = "select";
let annotColor = "#D0264A";
let annotWidth = 8;
let annotations = [];
// Undo/redo keeps SNAPSHOTS of the whole annotation list, not just the last item,
// because edits like moving or resizing a shape change it in place - popping the
// last item could never undo those.
let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 60;
// An entry IS the cloned annotation array (so undoStack[i].length still counts marks),
// tagged with .rects - the page rectangles in force when it was taken. A DOCUMENT entry
// (Crop, and later Join / Swap / Undo join) also carries .doc - what the picture was - and
// .rid, the Recent row it belonged to. Only snapAnnots() and snapDoc() make entries; restores
// use e.slice(), so the tags never leak into the live list.
let hostPid = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);   // this tab's own page
let docBusy = null;          // a Promise while a document restore composes; edits wait for it
let docDirty = false;        // the picture changed shape since its Recent row was last written
let exportingAnnots = false;   // true while flattening: skip on-screen-only selection UI
// A marquee waiting for Delete. Paint-style: the drag picks the area, Delete erases it.
// Deliberately NOT an annotation - it carries no ink, exports nothing, and is dropped
// the moment attention moves elsewhere, so it can never be left behind invisibly.
let pendingSel = null;
let liveAnnot = null;
let activePointerId = null;
let activeAnnot = null;      // the selected / just-drawn shape (Paint-style live editing)
let activeTouched = false;   // has the active shape been edited in place yet? (one undo step per edit session)
let drag = null;             // { a, sx, sy, orig, moved } while moving a shape with the Select tool
let stepNums = null;         // Map step-annotation -> its number, rebuilt on every render (D2: reading order)
let edge = null;             // edge auto-scroll state for the gesture in progress (see edgeBegin)
const ANNOT_COLORS = ["#D0264A", "#C2530A", "#9A6700", "#0F7A42", "#1D5FD6", "#12151A", "#FFFFFF"];
// QA bug-report stamps — click to drop a labelled pill (kind → label + colour).
const STAMPS = {
  bug:    { label: "BUG",     color: "#D0264A" },
  pass:   { label: "PASS",    color: "#0F7A42" },
  fixed:  { label: "FIXED",   color: "#9A6700" },
  retest: { label: "RE-TEST", color: "#1D5FD6" }
};
let stampKind = "bug";

/* ------------------------- Boot ------------------------- */
init();

async function init() {
  try {
    const s = await chrome.storage.sync.get("settings");
    Object.assign(defaultSettings, s.settings || {});
  } catch (_) {}
  currentFormat = defaultSettings.format || "png";
  quality = defaultSettings.jpegQuality || 0.92;
  infoBar = defaultSettings.infoBar !== false;
  envBar = defaultSettings.envBar !== false;
  recentEnabled = defaultSettings.recentEnabled === true;   // strictly opt-in
  const rbtn = el("recentBtn"); if (rbtn) rbtn.hidden = !recentEnabled;
  el("quality").value = quality;
  el("qualityVal").textContent = Math.round(quality * 100) + "%";
  paintQuality();
  reflectFormat();
  wireTools();
  rosterInit();               // before the no-job branch: a ?recent=1 editor that reopens a capture joins too
  learnMyTab();

  if (!jobId) {
    settleCapture();
    if (params.get("recent") === "1") { progressWrap.hidden = true; openRecent(); return; }
    return showError("Missing capture reference. Please try capturing again.");
  }

  const port = chrome.runtime.connect({ name: "fpc-result" });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    // Connection dropped before we ever received the image (e.g. the service
    // worker was terminated). If we're still on the spinner, surface an error
    // instead of leaving the user stuck forever.
    if (!aborted && !meta && errorWrap.hidden) {
      showError("The capture connection was lost. Please try capturing again.");
    }
  });
  port.postMessage({ type: "ready", job: jobId });
  const rb = el("recentBtn"); if (rb) rb.disabled = true;   // re-enabled by settleCapture()
}
// Annotate is on whenever it can be: a single-canvas image, and not while
// cropping. Those two are real constraints, not preferences - annotation does
// not work across a split canvas (setupAnnotationLayer bails), and the crop
// overlay owns the pointer while it is up.
function maybeAnnot() {
  if (annotating || cropping) return;
  if (segments.length !== 1) return;
  startAnnot();
}

function settleCapture() {
  captureSettled = true;
  const rb = el("recentBtn"); if (rb) { rb.disabled = false; rb.hidden = !recentEnabled; }
}

/* ------------------------- Port handling ------------------------- */
function onPortMessage(msg) {
  if (!msg || aborted) return;
  if (msg.type === "error") return msg.code === "expired" ? onExpired() : showError(msg.error);
  if (msg.type === "meta") return onMeta(msg.meta, msg.count);
  // Tiles decode asynchronously. Serialize them and defer finalize() until they have
  // ALL drawn — otherwise finalize snapshots a half-empty canvas (and the info bar
  // gets painted over by a tile that arrives late).
  if (msg.type === "tile") {
    tileChain = tileChain.then(() => onTile(msg.tile)).catch((e) => showError(e.message || String(e)));
    return;
  }
  if (msg.type === "done") {
    tileChain.then(() => finalize());
    return;
  }
}

function onMeta(m, count) {
  if (aborted) return;
  meta = m;
  expected = count;
  dpr = m.dpr || 1;
  scrollbarLeft = !!m.scrollbarLeft;
  progressTitle.textContent = m.mode === "visible" ? "Preparing screenshot…" : "Stitching screenshot…";

  if (m.mode === "full" || m.mode === "region") {
    cropWpx = Math.round(m.clientW * dpr);
    cropHpx = Math.round(m.clientH * dpr);
    const R = m.region;                     // output rectangle in page CSS px
    const wantW = Math.round(R.w * dpr);
    fullWpx = Math.min(MAX_SIDE, wantW);
    fullHpx = Math.round(R.h * dpr);
    truncated = wantW > MAX_SIDE;
    buildSegments(fullWpx, fullHpx);
  }
  // visible mode: segment is created on the first (only) tile at natural size.
}

function buildSegments(w, h) {
  segments = [];
  const perArea = Math.floor(MAX_AREA / Math.max(1, w));
  const segLimit = Math.max(1000, Math.min(HARD_SEG_HEIGHT, perArea));
  let y = 0;
  while (y < h) {
    const sh = Math.min(segLimit, h - y);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    canvasHost.insertBefore(canvas, cropOverlay);
    segments.push({ canvas, ctx, startY: y, height: sh });
    y += sh;
  }
}

async function decodeTile(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  try {
    return await createImageBitmap(blob);
  } catch (_) {
    // Fallback via <img>
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/* ------------------------- Drop, paste & file (Join sources) ------------------------- */
// Pictures come in three ways, none of which needs a permission: a file dropped anywhere on the
// editor, the hidden <input type=file> behind "Choose image file…", and the paste EVENT (Ctrl+V).
// navigator.clipboard.read() would need "clipboardRead"; the paste event does not.
// Every drag that reaches this page is answered here, in the capture phase on window, so no
// element can stop it first: a drop the page does not cancel is "opened" by the browser, which
// navigates the tab away and loses the capture (the v1.2.0 bug).
const INGEST_MAX_BYTES = 100 * 1024 * 1024;  // a 32 Mpx screenshot PNG is 10-40 MB
const INGEST_MAX_FILES = 8;
const COPY_TTL_MS = 30 * 60 * 1000;          // how long another editor's Copy can lend its name to a paste
const COPY_KEEP = 10;
let ingestBusy = false;
let lastOwnCopy = null;                      // { w, h, fp } of this tab's last Copy
let ownExports = [];                         // { w, h, fp } of this tab's last Downloads / Copies

function dragHasFiles(dt) {
  try { return !!dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0; } catch (_) { return false; }
}
// Why a picture can't be added right now, or null when it can.
function ingestGate() {
  if (stage.hidden && !(jobId && !captureSettled)) return "Open a capture first, then add a picture to it.";
  if (ingestBusy) return "Still adding the last picture…";
  return joinBlockedReason();
}

let dragDepth = 0, dragWatch = null;
function showDropOverlay(reason) {
  const o = el("dropOverlay"); if (!o) return;
  const m = el("dropMsg"); if (m) m.textContent = reason || "Drop to join with this capture";
  o.classList.toggle("blocked", !!reason);
  o.hidden = false;
  clearTimeout(dragWatch);                    // backstop in case a dragleave is never delivered
  dragWatch = setTimeout(hideDropOverlay, 3000);
}
function hideDropOverlay() {
  dragDepth = 0; clearTimeout(dragWatch); dragWatch = null;
  const o = el("dropOverlay"); if (o) o.hidden = true;
}
function onDragOver(e) {
  const dt = e.dataTransfer;
  const files = dragHasFiles(dt);
  if (!files && isTextEntry(e.target)) return;   // text into a text box: the browser's own insert
  e.preventDefault();                            // the page decides, so the browser never opens the drop
  const reason = files ? ingestGate() : null;
  try { if (dt) dt.dropEffect = files && !reason ? "copy" : "none"; } catch (_) {}
  if (files && !stage.hidden) showDropOverlay(reason);
}
function onDragEnter(e) { if (dragHasFiles(e.dataTransfer)) dragDepth++; onDragOver(e); }
function onDragLeave(e) {
  if (!dragHasFiles(e.dataTransfer)) return;
  if (--dragDepth <= 0) hideDropOverlay();
}
function onDrop(e) {
  const dt = e.dataTransfer;
  const hasFiles = dragHasFiles(dt);
  if (!hasFiles && isTextEntry(e.target)) return;
  e.preventDefault();                            // never navigate to / open what was dropped
  hideDropOverlay();
  // Read everything NOW: the DataTransfer is emptied as soon as this handler returns.
  let files = [], folders = 0, uri = "", html = "";
  try {
    const items = Array.from((dt && dt.items) || []).filter((i) => i.kind === "file");
    if (items.length && items[0].webkitGetAsEntry) {
      for (const i of items) {
        const en = i.webkitGetAsEntry();
        if (en && en.isDirectory) { folders++; continue; }
        const f = i.getAsFile(); if (f) files.push(f);
      }
    } else files = Array.from((dt && dt.files) || []);
  } catch (_) { try { files = Array.from((dt && dt.files) || []); } catch (_) {} }
  if (!files.length && folders) { if (!stage.hidden) toast("Drop the pictures themselves, not a folder."); return; }
  if (!files.length) {
    try { uri = dt ? String(dt.getData("text/uri-list") || "") : ""; html = dt ? String(dt.getData("text/html") || "") : ""; } catch (_) {}
    if (stage.hidden) return;
    if (/<img[\s>]/i.test(html) || /^\s*https?:/i.test(uri)) toast("To join a picture from a web page, save it to your PC first, then drop the file.");
    return;
  }
  const reason = ingestGate();
  if (reason) { toast(reason); return; }
  ingestFiles(files, "file");
}

function onPaste(e) {
  if (isTextEntry(e.target)) return;             // typing in a text / callout box: a normal text paste
  const cd = e.clipboardData;
  let files = [];
  try {                                          // read NOW, before any await
    files = Array.from((cd && cd.files) || []);
    if (!files.length && cd && cd.items) {
      files = Array.from(cd.items).filter((i) => i.kind === "file" && /^image\//i.test(i.type || ""))
        .map((i) => i.getAsFile()).filter(Boolean);
    }
  } catch (_) {}
  if (stage.hidden) return;
  if (!files.length) { toast("Nothing to paste. Copy a picture first (Copy button or Win+Shift+S)."); return; }
  e.preventDefault();
  const reason = ingestGate();
  if (reason) { toast(reason); return; }
  ingestPaste(files[0]);
}

function openJoinFilePicker() { const i = el("joinFile"); if (i) i.click(); }
function onJoinFileChange(e) {
  const input = e.target;
  const files = Array.from(input.files || []);  // copy BEFORE clearing: clearing empties input.files
  input.value = "";                              // so picking the same file again still fires "change"
  if (!files.length) return;                     // the picker was cancelled
  const reason = ingestGate();
  if (reason) { toast(reason); return; }
  ingestFiles(files, "file");
}

// Wired at script load (not in wireTools, which only runs after init's first await): from the
// first frame, no drop can ever navigate this tab.
function wireIngest() {
  window.addEventListener("dragstart", (e) => { if (!isTextEntry(e.target)) e.preventDefault(); }, true);
  window.addEventListener("dragenter", onDragEnter, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", hideDropOverlay, true);
  window.addEventListener("paste", onPaste);
  const fi = el("joinFile"); if (fi) fi.addEventListener("change", onJoinFileChange);
}
wireIngest();

/* ---- reading one picture safely ---- */
// Only Blob/File bytes are ever decoded (createImageBitmap, or an <img> on a blob: URL this
// page made), so the canvas stays origin-clean and Download / Copy / Drive keep working.
// A URL from a drag is never loaded: that would need a host permission and would taint.
function sniffImage(b) {
  const at = (i, s) => { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; };
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (at(0, "BM") && b.length >= 18 && [12, 40, 52, 56, 108, 124].indexOf(b[14] | b[15] << 8) >= 0) return "bmp";
  if (at(4, "ftyp")) {
    const brands = String.fromCharCode.apply(null, Array.from(b.subarray(8, Math.min(b.length, 40))));
    if (/avi[fs]/.test(brands)) return "avif";
    if (/hei[cxs]|mif1|msf1/.test(brands)) return "heic";
  }
  if (at(0, "%PDF-")) return "pdf";
  const txt = String.fromCharCode.apply(null, Array.from(b.subarray(0, Math.min(b.length, 256)))).replace(/^\xEF\xBB\xBF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(txt) || /^<\?xml/i.test(txt)) return "svg";
  return null;
}
const PICTURE_MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };

// Width and height from the header, without decoding. null = the header didn't say (yet).
function imageSize(b, kind) {
  const u16be = (i) => b[i] << 8 | b[i + 1], u16le = (i) => b[i] | b[i + 1] << 8;
  const u32be = (i) => (b[i] << 24 >>> 0) + (b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]);
  const i32le = (i) => b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24;
  const at = (i, s) => { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; };
  try {
    if (kind === "png") return b.length >= 24 && at(12, "IHDR") ? { w: u32be(16), h: u32be(20) } : null;
    if (kind === "gif") return b.length >= 10 ? { w: u16le(6), h: u16le(8) } : null;
    if (kind === "bmp") {
      if (b.length < 26) return null;
      if ((b[14] | b[15] << 8) === 12) return { w: u16le(18), h: u16le(20) };
      return { w: Math.abs(i32le(18)), h: Math.abs(i32le(22)) };   // negative height = top-down rows
    }
    if (kind === "webp") {
      if (b.length < 30) return null;
      if (at(12, "VP8 ")) return { w: u16le(26) & 0x3FFF, h: u16le(28) & 0x3FFF };
      if (at(12, "VP8L")) {
        const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
        return { w: 1 + ((b2 & 0x3F) << 8 | b1), h: 1 + ((b4 & 0xF) << 10 | b3 << 2 | (b2 & 0xC0) >> 6) };
      }
      if (at(12, "VP8X")) return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
      return null;
    }
    if (kind === "jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) return null;                          // lost sync: let the decoder decide
        const m = b[i + 1];
        if (m === 0xFF) { i++; continue; }                       // fill byte
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        if ((m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: u16be(i + 7), h: u16be(i + 5) };
        i += 2 + u16be(i + 2);
      }
      return null;
    }
    if (kind === "avif") {                                        // largest 'ispe' (grid images carry tiles too)
      let best = null;
      for (let i = 4; i + 16 <= b.length; i++) {
        if (at(i, "ispe")) { const w = u32be(i + 8), h = u32be(i + 12); if (!best || w * h > best.w * best.h) best = { w, h }; }
      }
      return best;
    }
  } catch (_) {}
  return null;
}
function checkPixels(w, h) {
  if (!(w > 0 && h > 0)) throw new Error("That picture couldn't be read.");
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > JOIN_MAX_PX) {
    throw new Error("That picture is too large to join (" + w + "×" + h + "). Capture just the part you need with Area (Alt+Shift+A), then join it.");
  }
}
async function decodeBlob(blob) {
  try {
    return await createImageBitmap(blob);
  } catch (_) {
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    finally { URL.revokeObjectURL(url); }
  }
}

// Reads one File/Blob into a join source. Throws an Error whose message is for the tester.
async function readPicture(file, origin) {
  const label = origin === "paste" ? "The pasted picture"
    : (file && file.name) ? "“" + file.name + "”" : "That picture";
  if (!file || !file.size) throw new Error(label + " is empty.");
  if (file.size > INGEST_MAX_BYTES) throw new Error(label + " is too big to join (over 100 MB).");
  let head;
  try { head = new Uint8Array(await file.slice(0, 65536).arrayBuffer()); }
  catch (_) { throw new Error(label + " couldn't be read. If it's a folder, drop the picture inside it."); }
  const kind = sniffImage(head);
  if (kind === "pdf") throw new Error(label + " is a PDF. Join needs a picture: download the capture as PNG or JPG, then add it.");
  if (kind === "svg" || kind === "heic" || !kind) throw new Error(label + " isn't a picture Join can use (PNG, JPG, WebP, GIF or BMP).");
  let dims = imageSize(head, kind);
  if (!dims && kind === "jpeg" && file.size > head.length) {
    dims = imageSize(new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()), kind);
  }
  if (dims) checkPixels(dims.w, dims.h);        // refuse BEFORE decoding: a huge decode can crash the tab
  // Copy the bytes into memory: a dropped File is read lazily from disk and throws once the
  // file is moved or deleted, but the page is re-composed on every Swap / layout / undo.
  const blob = new Blob([await file.arrayBuffer()], { type: PICTURE_MIME[kind] });
  let bmp;
  try { bmp = await decodeBlob(blob); } catch (_) { throw new Error(label + " couldn't be opened as a picture (the file may be damaged)."); }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  try {
    checkPixels(w, h);
    let fp = null;
    try { fp = fingerprint(bmp); } catch (_) {}
    return { origin, blob, w, h, kind, name: (file && file.name) || "", fp };
  } finally { if (bmp.close) bmp.close(); }
}
// A picture read from a file or the clipboard, as a join page. Its pixels are whatever the file
// holds (a downloaded capture already has its URL bar and marks drawn in), so no live bar.
function partFromPicture(p) {
  return { src: p.blob, w: p.w, h: p.h, dpr: dpr || 1, origin: p.origin,
    meta: { title: p.title || "Picture", url: p.url || "", env: null },
    stampTime: p.stampTime ? new Date(p.stampTime) : null, barOn: false, barBaked: false, wasCropped: false,
    capKey: null, srcEditorId: p.srcEditorId || null };
}

async function ingestFiles(files, origin) {
  if (files.length > INGEST_MAX_FILES) { toast("Add up to " + INGEST_MAX_FILES + " pictures at a time."); return; }
  ingestBusy = true;
  try {
    const pages = [], skipped = [];
    for (const f of files) {
      try {
        const p = await readPicture(f, origin);
        // The Downloads bubble lists the NEWEST file first - usually this tab's own download.
        if (isOwnExport(p)) skipped.push("“" + (p.name || "That picture") + "” is this same image. Pick the other page's file.");
        else pages.push(p);
      } catch (err) { skipped.push(err.message || String(err)); }
    }
    if (!pages.length) { toast(skipped[0] || "Couldn't add that picture."); return; }
    const host = hostTime();
    for (const p of pages) Object.assign(p, fileOrder(p.name, host), { title: fileTitle(p.name) });
    sortIncoming(pages);
    const res = await joinPages(pages.map((p) => ({ part: partFromPicture(p), marks: [], orderTime: p.orderTime })), { via: origin });
    joinResultToast(res, { via: origin, skipped, names: pages.map((p) => p.title) });
  } catch (err) {
    toast("Couldn't join: " + ((err && err.message) || err));
  } finally { ingestBusy = false; }
}

async function ingestPaste(file) {
  ingestBusy = true;
  try {
    const page = await readPicture(file, "paste");
    const m = await matchCopy(page);
    if (m && m.self) { toast("That's this same image."); return; }
    const host = hostTime();
    if (m) {
      Object.assign(page, { origin: "paste-copy", title: m.title || "Pasted picture", url: m.url || "",
        stampTime: m.stampTime || null, srcEditorId: m.editorId, orderTime: m.stampTime || host + 1 });
    } else {
      Object.assign(page, { title: "Pasted picture", orderTime: host + 1 });
    }
    const res = await joinPages([{ part: partFromPicture(page), marks: [], orderTime: page.orderTime }], { via: "paste" });
    joinResultToast(res, { via: "paste", names: [page.title] });
  } catch (err) {
    toast(err.message || "Couldn't paste that picture.");
  } finally { ingestBusy = false; }
}

/* ---- ordering a file by the time in its name ---- */
// The editor's own name is "{title}-{date}" by default, where {date} is the DOWNLOAD date and
// there is no time at all. Times that do appear: a {time} / Drive "-HHMMSS" right after the
// date, Windows Snipping Tool's "Screenshot YYYY-MM-DD HHMMSS", and a clock the page itself put
// in its title ("[11 04 22]" once ':' is sanitized). None is the capture clock, so a file's
// order is a guess (the arrange bar's Swap fixes it in one click).
function parseNameClock(name) {
  const stem = String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/\s*\(\d+\)$/, "").replace(/-part\d+$/i, "");
  const dates = [...stem.matchAll(/(?<!\d)(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/g)];
  const d = dates.length ? dates[dates.length - 1] : null;
  let clock = null, source = null;
  // 1) a clock the page put in its own title ("[11 04 22]"): page-load time, so never LATER than
  //    the capture - the safest signal for "this file is the earlier page".
  const c = /[\[(]\s*(\d{1,2})[ .:_-](\d{2})[ .:_-](\d{2})\s*(?:([AaPp])\.?[Mm]\.?)?\s*[\])]/.exec(stem);
  if (c) {
    let hh = +c[1]; const ap = c[4] && c[4].toLowerCase();
    if (ap === "p" && hh < 12) hh += 12; if (ap === "a" && hh === 12) hh = 0;
    if (hh < 24 && +c[2] < 60 && +c[3] < 60) { clock = [hh, +c[2], +c[3]]; source = "title"; }
  }
  // 2) a time right after the date: Snipping Tool (capture time), or {time} / the Drive stamp
  //    (download / upload time, so possibly later than the capture).
  if (!clock && d) {
    const t = /^(?:[-_ T]|\s+at\s+)([01]\d|2[0-3])[-_.: ]?([0-5]\d)[-_.: ]?([0-5]\d)(?!\d)/.exec(stem.slice(d.index + d[0].length));
    if (t) { clock = [+t[1], +t[2], +t[3]]; source = "stamp"; }
  }
  return { date: d ? [+d[1], +d[2], +d[3]] : null, clock, source };
}
// { orderTime (ms), side: "before" | "after" } relative to hostMs.
function fileOrder(name, hostMs) {
  const p = parseNameClock(name);
  const host = new Date(hostMs);
  const day = p.date || [host.getFullYear(), host.getMonth() + 1, host.getDate()];
  let t = null;
  if (p.clock) t = new Date(day[0], day[1] - 1, day[2], p.clock[0], p.clock[1], p.clock[2]).getTime();
  else if (p.date) {
    const start = new Date(day[0], day[1] - 1, day[2]).getTime();
    const hostStart = new Date(host.getFullYear(), host.getMonth(), host.getDate()).getTime();
    if (start < hostStart) t = start + 86399000;     // an earlier day: before this page
    else if (start > hostStart) t = start;           // a later day (this editor reopened an old capture)
  }
  if (t === null) t = hostMs - 1;                    // no usable time: before this page (usually the earlier page, downloaded)
  return { orderTime: t, side: t < hostMs ? "before" : "after", nameClock: p.source };
}
function fileTitle(name) {
  return String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/\s*\(\d+\)$/, "").replace(/-part\d+$/i, "")
    .replace(/[-_ ]?(20\d\d)-(\d\d)-(\d\d)(?:[-_ ]\d{6})?$/, "").trim() || "Picture";
}
// Several files at once: by time, then natural name order (part2 before part10).
function sortIncoming(pages) {
  pages.sort((a, b) => (a.orderTime - b.orderTime) ||
    String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" }));
}
function hostTime() {
  const s = stampTime || captureTime;
  return s ? new Date(s).getTime() : Math.round(performance.timeOrigin || Date.now());
}

/* ---- recognising a paste of another editor's Copy ---- */
// 32x32 luma of the picture. Size alone is useless (two visible captures on one monitor are
// both 1912x966), so a paste must match both the size and this fingerprint.
function fingerprint(src) {
  const mid = document.createElement("canvas"); mid.width = 256; mid.height = 256;
  const mc = mid.getContext("2d"); mc.imageSmoothingEnabled = true; mc.imageSmoothingQuality = "high";
  mc.drawImage(src, 0, 0, 256, 256);
  const fc = document.createElement("canvas"); fc.width = 32; fc.height = 32;
  const cc = fc.getContext("2d"); cc.imageSmoothingEnabled = true; cc.imageSmoothingQuality = "high";
  cc.drawImage(mid, 0, 0, 32, 32);
  const d = cc.getImageData(0, 0, 32, 32).data, out = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return out;
}
function fpDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
const fpToB64 = (fp) => btoa(String.fromCharCode.apply(null, Array.from(fp)));
const fpFromB64 = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch (_) { return null; } };

// doDownload (one image, PNG/JPG) calls this with the canvas it exported.
function recordOwnExport(canvas) {
  try { ownExports = ownExports.concat([{ w: canvas.width, h: canvas.height, fp: fingerprint(canvas) }]).slice(-3); } catch (_) {}
}
function isOwnExport(p) {
  // JPEG at q 0.4-1 moves 32x32 block means by well under 2 levels, so 2.5 still matches a JPG download
  return !!p.fp && ownExports.some((x) => x.w === p.w && x.h === p.h && fpDiff(x.fp, p.fp) <= 2.5);
}
// doCopy calls this after a successful clipboard write. Kept in chrome.storage.session (not only
// broadcast), because the tab that pastes is usually opened AFTER the Copy, and the copying tab
// may already be closed.
async function recordCopy(canvas) {
  try {
    const fp = fingerprint(canvas);
    lastOwnCopy = { w: canvas.width, h: canvas.height, fp };
    ownExports = ownExports.concat([lastOwnCopy]).slice(-3);
    const s = await chrome.storage.session.get("fpcCopies");
    const now = Date.now();
    const list = ((s && s.fpcCopies) || []).filter((r) => now - r.at < COPY_TTL_MS && r.editorId !== editorId);
    list.push({ editorId, w: canvas.width, h: canvas.height, fp: fpToB64(fp),
      title: (meta && meta.title) || "", url: (meta && meta.url) || "", stampTime: hostTime(), at: now,
      incognito: !!(meta && meta.incognito) });
    await chrome.storage.session.set({ fpcCopies: list.slice(-COPY_KEEP) });
  } catch (_) {}
}
async function matchCopy(page) {
  const LIMIT = 2.5;                        // mean luma difference; a real match is ~0
  if (!page.fp) return null;
  if (lastOwnCopy && lastOwnCopy.w === page.w && lastOwnCopy.h === page.h && fpDiff(lastOwnCopy.fp, page.fp) <= LIMIT) return { self: true };
  let list = [];
  try { const s = await chrome.storage.session.get("fpcCopies"); list = (s && s.fpcCopies) || []; } catch (_) {}
  const now = Date.now(), inc = !!(meta && meta.incognito);
  let best = null, bestD = Infinity;
  for (const r of list) {
    if (now - r.at >= COPY_TTL_MS || r.w !== page.w || r.h !== page.h || !!r.incognito !== inc) continue;
    const d = fpDiff(fpFromB64(r.fp), page.fp);
    if (d < bestD || (d === bestD && best && r.at > best.at)) { best = r; bestD = d; }
  }
  if (!best || bestD > LIMIT) return null;
  return best.editorId === editorId ? { self: true } : best;
}

// What a join from any source says when it is done. The arrange bar's action message (with its
// Undo button) replaces this once the join UI is in.
function joinResultToast(res, info) {
  info = info || {};
  if (!res || !res.ok) { if (res && res.reason && !res.cancelled) toast(res.reason); return; }
  const skipped = (info.skipped || []).length;
  toast("Joined " + (info.names && info.names.length ? info.names.join(", ") : "the page") + " — Ctrl+Z undoes it" +
    (skipped ? " (" + skipped + " file" + (skipped > 1 ? "s" : "") + " skipped)" : ""));
}

async function onTile(tile) {
  if (aborted) return;
  const bmp = await decodeTile(tile.dataUrl);
  if (aborted) { if (bmp.close) bmp.close(); return; }
  const bw = bmp.width, bh = bmp.height;

  if (meta.mode === "visible") {
    if (segments.length === 0) {
      const canvas = document.createElement("canvas");
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext("2d");
      canvasHost.insertBefore(canvas, cropOverlay);
      segments.push({ canvas, ctx, startY: 0, height: bh });
      fullWpx = bw; fullHpx = bh;
    }
    segments[0].ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    bump();
    return;
  }

  // Full & region modes. Draw the part of this viewport tile that falls inside the
  // output rectangle meta.region (page CSS coords), placed relative to the region's
  // origin. Tile edges are rounded on the device-pixel grid, so adjacent tiles abut
  // seam-free (no fractional-dpr gaps). For full page, region = the whole document.
  const R = meta.region;
  const cW = meta.clientW, cH = meta.clientH;
  // Overlap of this tile's content viewport with the region, in page CSS px. Cap the
  // far edges to the canvas extent (fullWpx/fullHpx) so source & destination stay in
  // lockstep even when the width was truncated to MAX_SIDE (no horizontal squish).
  const ox0 = Math.max(tile.x, R.x), ox1 = Math.min(tile.x + cW, R.x + R.w, R.x + fullWpx / dpr);
  const oy0 = Math.max(tile.y, R.y), oy1 = Math.min(tile.y + cH, R.y + R.h, R.y + fullHpx / dpr);
  if (ox1 <= ox0 || oy1 <= oy0) { if (bmp.close) bmp.close(); bump(); return; }

  const destLeft = Math.round((ox0 - R.x) * dpr);
  let destRight = Math.min(fullWpx, Math.round((ox1 - R.x) * dpr));
  const destTop = Math.round((oy0 - R.y) * dpr);
  let destBot = Math.min(fullHpx, Math.round((oy1 - R.y) * dpr));
  // Close a ≤2px gap at the far edge if scrollTo landed a fraction short of maxScroll.
  if (destRight > destLeft && fullWpx - destRight <= 2) destRight = fullWpx;
  if (destBot > destTop && fullHpx - destBot <= 2) destBot = fullHpx;
  const destW = destRight - destLeft, destH = destBot - destTop;
  if (destW <= 0 || destH <= 0) { if (bmp.close) bmp.close(); bump(); return; }

  // Source rect inside the bitmap (its origin = page (tile.x, tile.y)). Content area
  // only — cropWpx/cropHpx exclude scrollbar gutters; on RTL content is right-aligned.
  // Inner-container capture: the container content sits at a device-px offset inside
  // each viewport tile (co.dx/co.dy), so shift the source rect to read from there.
  const co = meta.containerOffset || null;
  const contentOriginX = scrollbarLeft ? Math.max(0, bw - cropWpx) : 0;
  const srcX = contentOriginX + (ox0 - tile.x) * dpr + (co ? co.dx : 0);
  const srcYf = (oy0 - tile.y) * dpr + (co ? co.dy : 0);
  const srcW = (ox1 - ox0) * dpr;
  const srcHf = (oy1 - oy0) * dpr;
  const ry = srcHf / destH; // source-per-dest-row (≈ 1)

  for (const seg of segments) {
    const segTop = seg.startY, segBot = seg.startY + seg.height;
    const y0 = Math.max(destTop, segTop), y1 = Math.min(destBot, segBot);
    if (y1 <= y0) continue;
    const sSrcY = srcYf + (y0 - destTop) * ry;
    const sSrcH = (y1 - y0) * ry;
    seg.ctx.drawImage(bmp, srcX, sSrcY, srcW, sSrcH, destLeft, y0 - segTop, destW, y1 - y0);
  }
  if (bmp.close) bmp.close();
  bump();
}

function bump() {
  received++;
  const pct = expected ? Math.round((received / expected) * 100) : 100;
  progressFill.style.width = pct + "%";
  progressSub.textContent = `Section ${received} of ${expected}`;
  sectionCount = expected;
}

/* ------------------------- Finalize ------------------------- */
function finalize() {
  if (!meta || aborted) return;
  progressWrap.hidden = true;
  stage.hidden = false;
  tools.hidden = false;
  baseSeg0 = segments[0] ? segments[0].canvas : null;
  if (!stampTime) stampTime = captureTime || new Date();   // before the first bar is drawn
  applyInfoBar();            // stamp URL + time bar on top (if enabled)
  // Crop & annotate only make sense on a single-canvas image.
  const single = segments.length === 1;
  el("crop").disabled = !single;   // the disabled look belongs to result.css
  reflectInfoBarBtn();
  updateDims();
  applyZoom();
  if (truncated) toast("This page is extremely wide — the right edge was cut to the browser's canvas limit.");
  maybeAnnot();
  settleCapture();
  saveRecent();              // keep the last few captures so a closed tab isn't a lost capture
  syncProtection();          // an unexported capture must not be discarded
  syncDocTitle();
  rosterChanged(true);       // other editors can offer this capture for joining now
}

function updateDims() {
  const w = segments[0] ? segments[0].canvas.width : fullWpx;
  const h = segments.reduce((a, s) => a + s.canvas.height, 0);
  // The identity strip says WHAT you are looking at; the status bar says
  // what you will get. The long form (parts, truncation) moved there.
  el("dims").textContent = `${w}×${h}`;
  reflectStatus(w, h);
}

const TOOL_NAMES = { stamp: "Stamp", select: "Select", rect: "Box", ellipse: "Ellipse", arrow: "Arrow",
  line: "Line", pen: "Pen", highlight: "Highlighter", text: "Text",
  callout: "Callout", step: "Step", blur: "Blur", whiteout: "White out" };
function reflectToolName(name) { const n = el("toolName"); if (n) n.textContent = name; }

// The strip shows the current tool's own properties and nothing else.
// Colour is meaningless for blur and for a stamp (a stamp carries its own
// meaning-colour); the stamp chips are only relevant under the stamp tool.
// Slots are hidden with the [hidden] attribute, never removed - the [ and ]
// shortcuts reach into #awidth and dispatch synthetic events, so the slider
// has to stay in the DOM either way.
function reflectToolSlots() {
  const isStamp = annotTool === "stamp";
  const c = el("slotColour"), k = el("slotStamp");
  if (c) c.hidden = isStamp || annotTool === "blur" || annotTool === "whiteout";
  if (k) k.hidden = !isStamp;
  if (isStamp) {
    document.querySelectorAll(".astamp").forEach((b) =>
      b.classList.toggle("active", b.dataset.stamp === stampKind));
  }
}

// Purely reflective: reads meta / segments / currentFormat and writes text.
// Nothing here changes what the editor does.
function reflectStatus(w, h) {
  const t = el("capTitle");
  if (t) {
    let s = (meta && meta.title) || "";
    if (!s && meta && meta.url) {
      try { s = new URL(meta.url).hostname.replace(/^www\./, ""); } catch (_) { s = meta.url; }
    }
    t.textContent = s;
    t.title = s;
  }
  if (w === undefined) {
    w = segments[0] ? segments[0].canvas.width : fullWpx;
    h = segments.reduce((a, s) => a + s.canvas.height, 0);
  }
  const f = el("stFormat"); if (f) f.textContent = String(currentFormat || "png").toUpperCase();
  const d = el("stDims");   if (d) d.textContent = `${w}×${h}`;
  const p = el("stParts");
  if (p) {
    const bits = [];
    if (sectionCount > 1) bits.push(sectionCount + " sections");
    if (segments.length > 1) bits.push(segments.length + " parts");
    if (wasCropped) bits.push("cropped");
    if (truncated) bits.push("width truncated");
    p.textContent = bits.length ? bits.join(" · ") : "1 section";
  }
}

/* ------------------------- Info bar (URL + time) ------------------------- */
function fitText(ctx, str, maxW) {
  if (!str || maxW <= 0) return "";
  if (ctx.measureText("…").width > maxW) return "";        // no room even for an ellipsis
  if (str.length > 4096) str = str.slice(0, 4096);         // cap work for pathological URLs
  if (ctx.measureText(str).width <= maxW) return str;
  // Binary-search the longest prefix that fits with an ellipsis (O(log n) measures).
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(str.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + "…" : "";
}

function parseUA(ua) {
  ua = ua || ""; let m, browser = "", os = "";
  if ((m = ua.match(/Edg\/(\d+)/))) browser = "Edge " + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) browser = "Opera " + m[1];
  else if ((m = ua.match(/Firefox\/(\d+)/))) browser = "Firefox " + m[1];
  else if ((m = ua.match(/Chrome\/(\d+)/))) browser = "Chrome " + m[1];
  else if (/Safari\//.test(ua)) browser = (m = ua.match(/Version\/(\d+)/)) ? "Safari " + m[1] : "Safari";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iOS/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return { browser, os };
}
function formatEnv(env) {
  const p = parseUA(env.ua);
  const parts = [];
  if (p.browser) parts.push(p.browser);
  if (p.os) parts.push(p.os);
  if (env.vw && env.vh) parts.push(env.vw + "×" + env.vh);
  parts.push("DPR " + (Math.round((env.dpr || 1) * 100) / 100));
  if (env.loadMs && env.loadMs > 0) parts.push("Load " + (env.loadMs / 1000).toFixed(2) + "s");
  return parts.join("   ·   ");
}
function pageHasEnv(pg) { const m = pg && pg.meta; return !!(envBar && m && m.env && m.env.ua && m.env.vw); }
function hasEnvLine() { return pageHasEnv({ meta }); }
// The page a single capture's bar describes: this editor's own capture.
function selfPage() { return { meta, stampTime: stampTime || captureTime }; }

// Draws a URL + time bar for page pg, at (ox, oy), at scale d. Returns the URL's link rect in
// the canvas's device px (for PDF links) or null. A single capture calls it with no page, no
// offset and its own dpr, so its draw calls are exactly v1.2.0's.
function drawInfoBar(ctx, w, barH, pg, d, ox, oy) {
  pg = pg || selfPage(); d = d || dpr; ox = ox || 0; oy = oy || 0;
  const pm = pg.meta || {};
  let link = null;
  ctx.save();
  if (ox || oy) ctx.translate(ox, oy);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, barH);
  const line = Math.max(2, Math.round(2 * d));
  ctx.fillStyle = "#14b8a6";
  ctx.fillRect(0, barH - line, w, line);
  const pad = Math.round(16 * d);
  const fs = Math.round(13 * d);
  const rowH = barH - line;
  const twoLine = pageHasEnv(pg);
  const y1 = twoLine ? Math.round(rowH * 0.31) : Math.round(rowH / 2);
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fs}px system-ui, "Segoe UI", Arial, sans-serif`;

  let timeStr = (pg.stampTime || new Date()).toLocaleString();
  let timeW = ctx.measureText(timeStr).width;
  let maxUrlW = w - pad * 3 - timeW;
  if (maxUrlW < 40) {           // bar too narrow for both — keep the URL, drop the time
    timeStr = ""; timeW = 0;
    maxUrlW = w - pad * 2;
  }
  if (timeStr) {
    ctx.fillStyle = "#94a3b8";   // leftover indigo-era blue; now matches the env line
    ctx.fillText(timeStr, w - pad - timeW, y1);
  }
  const urlText = fitText(ctx, pm.url || "", maxUrlW);
  if (urlText) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(urlText, pad, y1);
    // Remember where the URL sits so PDF export can lay a clickable link over it.
    link = { x: ox + pad, y: oy, w: ctx.measureText(urlText).width, h: barH, uri: pm.url || "" };
  }

  // Line 2: environment metadata (Browser · OS · Viewport · DPR)
  if (twoLine) {
    ctx.font = `500 ${Math.round(11.5 * d)}px system-ui, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = "#9aa7bd";
    ctx.fillText(fitText(ctx, formatEnv(pm.env), w - pad * 2), pad, Math.round(rowH * 0.72));
  }
  ctx.restore();
  return link;
}

function barHeightFor(twoLine, d) { return Math.max(28, Math.round((twoLine ? 52 : 34) * d)); }
function infoBarHeight() { return barHeightFor(hasEnvLine(), dpr); }

function withInfoBar(base) {
  const barH = infoBarHeight();
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height + barH;
  const ctx = out.getContext("2d");
  infoBarLink = drawInfoBar(ctx, out.width, barH);
  ctx.drawImage(base, 0, barH);
  return out;
}

// Swap segments[0] between the pristine capture and the bar-stamped version.
function applyInfoBar() {
  if (doc || !baseSeg0 || !segments[0]) return;   // a joined image draws one bar per page (composeCanvas)
  if (!infoBar) infoBarLink = null; // withInfoBar (which sets it) won't run when off
  swapSeg0(infoBar ? withInfoBar(baseSeg0) : baseSeg0);
}
// Put a new canvas in segments[0]'s place, keeping it UNDER the annotation layer.
function swapSeg0(target) {
  const seg = segments[0];
  if (seg.canvas === target) return;
  const before = segments[1] ? segments[1].canvas : (annotCanvas || cropOverlay);
  seg.canvas.remove();
  canvasHost.insertBefore(target, before);
  seg.canvas = target;
  seg.ctx = target.getContext("2d");
  seg.height = target.height;
  pixRev++;
}

function reflectInfoBarBtn() {
  const btn = el("infobar");
  if (!btn) return;
  const disabled = stampLocked || segments.length !== 1;
  btn.classList.toggle("on", infoBar);
  btn.disabled = disabled;
  btn.title = segments.length !== 1
    ? "URL/time bar can't be toggled on a multi-part image"
    : stampLocked
      ? "URL/time bar is locked after cropping"
      : (infoBar ? "URL + time bar is ON — click to remove" : "Add a bar with the page URL and capture time");
}

// Shift every annotation's Y by dy (used when the top bar is added/removed).
function shiftAnnotList(list, dy) {
  for (const a of list) {
    if (typeof a.y1 === "number") a.y1 += dy;
    if (typeof a.y2 === "number") a.y2 += dy;
    if (a.points) for (const p of a.points) p.y += dy;
  }
}
// The undo/redo snapshots are independent copies in the same coordinate space, so
// they must move with the live list - otherwise undo restores shapes barH px off.
function shiftAnnotations(dy) {
  shiftAnnotList(annotations, dy);   // history entries carry their own rects; a restore remaps them
}

function toggleInfoBar() {
  if (doc || stampLocked || segments.length !== 1 || docBusy) return;   // joined: the per-page bar menu handles it
  const barH = infoBarHeight();
  const turningOn = !infoBar;
  infoBar = !infoBar;
  applyInfoBar();
  // The image just grew/shrank by barH at the top — keep annotations aligned by
  // shifting them the same amount and resizing the annotation layer to match.
  if (annotCanvas) {
    shiftAnnotations(turningOn ? barH : -barH);
    annotCanvas.width = segments[0].canvas.width;
    annotCanvas.height = segments[0].canvas.height;
    renderAnnots();
  }
  reflectInfoBarBtn();
  updateDims();
  applyZoom();
}

/* ------------------------- Joined document (Join Pages) ------------------------- */
// A single capture never touches any of this: doc stays null and every existing path
// (applyInfoBar, toggleInfoBar, saveRecent, the PDF link) behaves exactly as in v1.2.0.
// A joined image is doc = { dpr, dir, matchHeights, matchText, cuts, parts: [part, ...] }:
//   parts are in DISPLAY order (Swap = reverse the array) and are IMMUTABLE - a change makes a
//   new part object with the same pid - so history entries can share them by reference.
//   part = { pid, src (HTMLCanvasElement for this tab's own page | Blob PNG), w, h (page px,
//            no live bar), dpr, meta: {title, url, env}, stampTime, barOn, barBaked,
//            label?, legacy? (host only: the single-capture globals, for collapse) }
// segments[0].canvas is the COMPOSITE (bars + pages + grey + continues strips, no marks), so
// flatten / Download / Copy / Print / Drive work unchanged.
let doc = null;          // null = single capture
let docLayout = null;    // the layoutParts() result in force - rects for blur clip, step order, remap
let docLinks = [];       // [{x,y,w,h,uri}] composite device px, one per live URL bar (PDF links)
let composing = false;   // true while applyDoc awaits decodes: edits and other doc ops wait

const JOIN_GUTTER_CSS = 16;        // grey seam between pages (x host DPR)
const JOIN_STRIP_CSS = 28;         // "▼ <page> continues below (cut to fit)"
const JOIN_CLEAR_CSS = 48;         // a cut never lands closer than this under a mark
const JOIN_MIN_KEEP_CSS = 200;     // never cut a page to less than this (tiny partner guard)
const JOIN_MAX_PX = 32000000;      // memory budget for the joined canvas
const JOIN_MATCH_RATIO = 1.5;      // D1: Match heights defaults ON above this
const JOIN_FILL = "#E2E6EA";
const JOIN_STRIP_BG = "#475569", JOIN_STRIP_FG = "#F1F5F9";

function isJoined() { return !!doc && doc.parts.length > 1; }

// This tab's own capture as a page. Pixels are baseSeg0 (the pristine capture; after a crop it
// IS the cropped picture, bar included, hence barBaked).
// The pid is hostPid, the same identity history entries use for this page, so marks follow
// it between the single capture and any joined layout.
function hostPart() {
  if (doc || segments.length !== 1 || !baseSeg0 || !captureSettled || aborted) return null;
  return {
    pid: hostPid, origin: "host", src: baseSeg0, w: baseSeg0.width, h: baseSeg0.height, dpr,
    meta: { title: meta && meta.title, url: meta && meta.url, env: meta && meta.env },
    stampTime: stampTime || captureTime, barOn: !stampLocked && infoBar, barBaked: stampLocked, wasCropped,
    legacy: { meta, infoBar, stampLocked, wasCropped, captureTime, stampTime, truncated, sectionCount }
  };
}

// The single capture's page rect, in the same shape as layoutParts() rects (for remap).
function singleRect() {
  const c = segments[0] && segments[0].canvas;
  const barH = (infoBar && !stampLocked && !doc) ? infoBarHeight() : 0;
  const w = c ? c.width : 0, h = c ? c.height - barH : 0;
  return { pid: hostPid, i: 0, x: 0, y: 0, w, h: h + barH, barH, cx: 0, cy: barH, cw: w, ch: h, scale: 1, visibleH: h, stripH: 0, cut: false };
}

// ---- pure layout: no DOM, no globals except the canvas limits ----
function layoutParts(d, env) {
  const hd = env.hostDpr || 1;
  const parts = d.parts, n = parts.length;
  const G = n > 1 ? Math.round(JOIN_GUTTER_CSS * hd) : 0;
  const S = Math.round(JOIN_STRIP_CSS * hd);
  const live = (p) => p.barOn && !p.barBaked;
  // ONE bar height for the whole document, at the host's scale, so the bars form one row.
  const docBarH = barHeightFor(parts.some((p) => live(p) && pageHasEnv(p)), hd);
  const minDpr = Math.min(...parts.map((p) => p.dpr || 1));
  const cuts = d.cuts || {}, floor = env.markFloor || {};
  const cells = parts.map((p, i) => {
    const scale = d.matchText ? minDpr / (p.dpr || 1) : 1;
    const barH = live(p) ? docBarH : 0;
    const cw = Math.round(p.w * scale), fullCh = Math.round(p.h * scale);
    const f = floor[p.pid];
    const floorCh = (typeof f === "number" && isFinite(f)) ? Math.ceil(f * scale) + Math.round(JOIN_CLEAR_CSS * hd) : 0;
    const minKeep = Math.min(fullCh, Math.max(floorCh, Math.round(JOIN_MIN_KEEP_CSS * hd)));
    const c = { pid: p.pid, i, scale, barH, cw, fullCh, minKeep, natural: barH + fullCh, keepCh: fullCh };
    const want = cuts[p.pid];
    if (typeof want === "number" && want < p.h) c.keepCh = Math.max(minKeep, Math.round(want * scale));
    return c;
  });
  const row = d.dir !== "col";
  const nat = cells.map((c) => c.natural);
  const ratio = n > 1 ? Math.max(...nat) / Math.max(1, Math.min(...nat)) : 1;
  const matchShown = row && n > 1 && Math.max(...nat) !== Math.min(...nat);
  const matchOn = matchShown && (d.matchHeights == null ? ratio > JOIN_MATCH_RATIO : !!d.matchHeights);
  if (matchOn) {
    const T = Math.min(...nat);
    for (const c of cells) if (c.natural > T + S) c.keepCh = Math.min(c.keepCh, Math.max(T - S - c.barH, c.minKeep));
  }
  let x = 0, y = 0, W = 0, H = 0;
  const rects = cells.map((c) => {
    if (c.keepCh + S >= c.fullCh) c.keepCh = c.fullCh;       // a cut that saves nothing is no cut
    const cut = c.keepCh < c.fullCh, stripH = cut ? S : 0;
    const ch = cut ? c.keepCh : c.fullCh, cellH = c.barH + ch + stripH;
    const r = { pid: c.pid, i: c.i, x, y, w: c.cw, h: cellH, barH: c.barH, cx: x, cy: y + c.barH, cw: c.cw, ch,
                scale: c.scale, visibleH: cut ? Math.floor(c.keepCh / c.scale) : parts[c.i].h, stripH, cut };
    if (row) { x += c.cw + G; W = x - G; H = Math.max(H, cellH); } else { y += cellH + G; H = y - G; W = Math.max(W, c.cw); }
    return r;
  });
  let fits = true, reason = null;
  if (n > 1) {
    const hCap = Math.min(HARD_SEG_HEIGHT, Math.floor(MAX_AREA / Math.max(1, W)));
    if (W > MAX_SIDE) { fits = false; reason = row ? "Too wide to put side by side." : "Too wide to join."; }
    else if (H > hCap) { fits = false; reason = row ? "Too tall to join side by side." : "Too tall to put one under the other."; }
    else if (W * H > JOIN_MAX_PX) { fits = false; reason = "Too big to join whole (" + Math.round(W * H / 1e6) + " megapixels; the limit is " + JOIN_MAX_PX / 1e6 + ")."; }
  }
  return { W, H, gutter: G, stripH: S, docBarH, rects, ratio, matchShown, matchOn, fits, reason };
}

// Explicit cuts {pid: visibleH} that make the layout fit without cutting above a mark, or null.
function cutToFit(d, env) {
  const L0 = layoutParts(Object.assign({}, d, { cuts: {} }), env);
  if (L0.fits) return {};
  if (L0.W > MAX_SIDE) return null;
  const hd = env.hostDpr || 1, S = L0.stripH, G = L0.gutter, row = d.dir !== "col";
  const cells = L0.rects.map((r) => {
    const p = d.parts[r.i], f = (env.markFloor || {})[p.pid];
    const fullCh = Math.round(p.h * r.scale);
    const floorCh = (typeof f === "number" && isFinite(f)) ? Math.ceil(f * r.scale) + Math.round(JOIN_CLEAR_CSS * hd) : 0;
    return { pid: p.pid, scale: r.scale, barH: r.barH, fullCh, natural: r.barH + fullCh,
             minKeep: Math.min(fullCh, Math.max(floorCh, Math.round(JOIN_MIN_KEEP_CSS * hd))) };
  });
  const hMax = Math.min(HARD_SEG_HEIGHT, Math.floor(MAX_AREA / L0.W), Math.floor(JOIN_MAX_PX / L0.W));
  const cellAt = (c, cap) => (c.natural <= cap) ? c.natural : Math.min(c.natural, Math.max(c.barH + c.minKeep + S, cap));
  const total = (cap) => row ? Math.max(...cells.map((c) => cellAt(c, cap))) : cells.reduce((a, c) => a + cellAt(c, cap), 0) + G * (cells.length - 1);
  if (total(0) > hMax) return null;
  let lo = 0, hi = Math.max(...cells.map((c) => c.natural));
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (total(mid) <= hMax) lo = mid; else hi = mid - 1; }
  const out = {};
  for (const c of cells) {
    if (c.natural <= lo) continue;
    const keepCh = Math.max(c.minKeep, lo - c.barH - S);
    if (keepCh + S < c.fullCh) out[c.pid] = Math.floor(keepCh / c.scale);
  }
  return out;
}

// Which page a point belongs to: inside a cell wins, otherwise the nearest cell.
function pageIndexAt(pt, rects) {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < rects.length; k++) {
    const r = rects[k];
    const dx = Math.max(r.x - pt.x, 0, pt.x - (r.x + r.w)), dy = Math.max(r.y - pt.y, 0, pt.y - (r.y + r.h));
    const dd = dx * dx + dy * dy;
    if (dd < bestD) { bestD = dd; best = k; }
  }
  return best;
}
// Page-local <-> composite, for the annotation slice's remap.
function toPage(pt, r) { return { u: (pt.x - r.cx) / r.scale, v: (pt.y - r.cy) / r.scale }; }
function toComposite(u, v, r) { return { x: r.cx + u * r.scale, y: r.cy + v * r.scale }; }

// D2: continuous numbering in reading order - page order first, then drawing order.
function stepNumbers(list, rects) {
  const steps = [];
  list.forEach((a, idx) => { if (a.type === "step") steps.push({ a, idx, pg: rects ? pageIndexAt({ x: a.x1, y: a.y1 }, rects) : 0 }); });
  steps.sort((u, v) => u.pg - v.pg || u.idx - v.idx);
  const m = new Map();
  steps.forEach((s, k) => m.set(s.a, k + 1));
  return m;
}

function pageLabel(p) {
  if (p.label) return p.label;                                  // title slice: the page's own part of the joined title
  if (p.meta && p.meta.title) return p.meta.title;
  try { return new URL(p.meta.url).hostname.replace(/^www\./, ""); } catch (_) { return "This page"; }
}
function exportHost() {
  const urls = doc ? doc.parts.map((p) => p.meta && p.meta.url) : [meta && meta.url];
  const hosts = [];
  for (const u of urls) {
    let h = ""; try { h = new URL(u).hostname.replace(/^www\./, ""); } catch (_) {}
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  return hosts.join("+");
}

function drawContinuesStrip(ctx, r, label, d) {
  const y = r.cy + r.ch;
  ctx.save();
  ctx.fillStyle = JOIN_STRIP_BG;
  ctx.fillRect(r.x, y, r.cw, r.stripH);
  const pad = Math.round(16 * d);
  ctx.font = `600 ${Math.round(12.5 * d)}px system-ui, "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = JOIN_STRIP_FG;
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, "▼ " + label + " continues below (cut to fit)", r.cw - pad * 2), r.x + pad, y + Math.round(r.stripH / 2));
  ctx.restore();
}

async function decodePart(p) {
  if (typeof Blob !== "undefined" && p.src instanceof Blob) return { img: await createImageBitmap(p.src), owned: true };
  return { img: p.src, owned: false };                          // this tab's own canvas: never closed
}

// Draws the document WITHOUT marks: grey, then per page its bar, its pixels (cut / scaled), its strip.
async function composeCanvas(d, L) {
  const out = document.createElement("canvas");
  out.width = L.W; out.height = L.H;
  const ctx = out.getContext("2d");
  if (d.parts.length > 1) { ctx.fillStyle = JOIN_FILL; ctx.fillRect(0, 0, L.W, L.H); }   // 1 page: nothing to fill
  const links = [];
  for (const r of L.rects) {
    const p = d.parts[r.i];
    if (r.barH) { const lk = drawInfoBar(ctx, r.cw, r.barH, p, d.dpr, r.x, r.y); if (lk && lk.uri) links.push(lk); }
    const dec = await decodePart(p);
    try {
      if (r.cut || r.scale !== 1) {
        if (r.scale !== 1) ctx.imageSmoothingQuality = "high";
        ctx.drawImage(dec.img, 0, 0, p.w, r.visibleH, r.cx, r.cy, r.cw, r.ch);
      } else {
        ctx.drawImage(dec.img, r.cx, r.cy);
      }
    } finally {
      if (dec.owned && dec.img.close) dec.img.close();
    }
    if (r.stripH) drawContinuesStrip(ctx, r, pageLabel(p), d.dpr);
  }
  return { canvas: out, links };
}

// Lays out + composes `next` and makes it the image. Marks are moved by the CALLER's
// opts.placeMarks(newLayout), which runs synchronously right after the swap and before the
// first render - so nothing can be drawn against a half-applied layout.
async function applyDoc(next, opts) {
  opts = opts || {};
  const L = layoutParts(next, { hostDpr: next.dpr, markFloor: opts.markFloor || next.floor || {} });
  if (next.parts.length > 1 && !L.fits) return { ok: false, reason: L.reason, layout: L };
  composing = true;
  let composed;
  try { composed = await composeCanvas(next, L); } finally { composing = false; }
  const { canvas, links } = composed;
  canvas._fpcComposite = true;
  const old = segments[0].canvas;
  swapSeg0(canvas);
  // A composite is always re-composable from parts, so free its memory now instead of at GC.
  // NEVER zero anything else: baseSeg0 / a part's src can be segments[0].canvas (bar off, or cropped).
  if (old && old._fpcComposite && old !== canvas) { old.width = 0; old.height = 0; }
  fullWpx = L.W; fullHpx = L.H;
  doc = next; docLayout = L; docLinks = links;
  // The joined picture is one image now: its own title (both pages), its own identity. The
  // host's single-capture state lives on in its part's .legacy, for collapse.
  baseSeg0 = canvas; meta = next.meta || meta; hostPid = next.hostPid || hostPid;
  stampLocked = false; wasCropped = false;
  if (!annotCanvas) setupAnnotationLayer(); else { annotCanvas.width = L.W; annotCanvas.height = L.H; }
  if (opts.placeMarks) opts.placeMarks(L);
  renderAnnots();
  reflectInfoBarBtn();
  updateDims();
  zoom = null; applyZoom(); stage.scrollTop = 0; stage.scrollLeft = 0;
  return { ok: true, layout: L };
}

async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return c;
}

// Back to a plain single capture of page p (Undo join / pages removed down to one). The host
// page restores its exact v1.2.0 globals; another page becomes a capture of its own.
async function collapseToSingle(p, opts) {
  opts = opts || {};
  const canvas = (typeof Blob !== "undefined" && p.src instanceof Blob) ? await blobToCanvas(p.src) : p.src;
  const g = p.legacy || { meta: Object.assign({ mode: "visible", dpr: p.dpr }, p.meta), infoBar: p.barOn, stampLocked: p.barBaked,
                          wasCropped: false, captureTime: null, stampTime: p.stampTime, truncated: false, sectionCount: 0 };
  const old = segments[0].canvas;
  doc = null; docLayout = null; docLinks = [];
  meta = g.meta; dpr = p.dpr || 1; infoBar = g.infoBar; stampLocked = g.stampLocked; wasCropped = g.wasCropped;
  captureTime = g.captureTime; stampTime = g.stampTime; truncated = g.truncated; sectionCount = g.sectionCount;
  baseSeg0 = canvas; hostPid = p.pid;
  if (stampLocked) { infoBarLink = null; swapSeg0(canvas); } else applyInfoBar();
  if (old && old._fpcComposite && old !== segments[0].canvas) { old.width = 0; old.height = 0; }
  fullWpx = canvas.width; fullHpx = canvas.height;
  if (annotCanvas) { annotCanvas.width = segments[0].canvas.width; annotCanvas.height = segments[0].canvas.height; }
  if (opts.placeMarks) opts.placeMarks(singleRect());
  renderAnnots();
  reflectInfoBarBtn();
  updateDims();
  zoom = null; applyZoom(); stage.scrollTop = 0; stage.scrollLeft = 0;
}

/* ------------------------- Join Pages: titles, join, undo join ------------------------- */
// "UMS DEV - Mentor Dashboard [11 04 22] - Md. Sakil Mahmud" + "UMS DEV - Details Report
// [11 11 41] - Md. Sakil Mahmud" -> "UMS DEV - Mentor Dashboard [11 04 22] + Details Report
// [11 11 41] - Md. Sakil Mahmud": the shared start and end once, every page's own name kept
// (the hand-joined file lost page B's name). Cut only at " - " / " | " / " · " style separators,
// never inside a word. Each page's own part becomes its label (continues strip, chips).
const TITLE_SEP = /(\s[-|·–—]\s)/;
function joinTitles(parts) {
  const raw = parts.map((p) => String((p.meta && p.meta.title) || "").trim() || pageLabel(p));
  const split = raw.map((t) => t.split(TITLE_SEP));               // [seg, sep, seg, sep, seg]
  const segs = split.map((a) => a.filter((_, i) => i % 2 === 0));
  const n = Math.min(...segs.map((a) => a.length));
  let pre = 0;
  while (pre < n - 1 && segs.every((a) => a[pre] === segs[0][pre])) pre++;
  let suf = 0;
  while (suf < n - 1 - pre && segs.every((a) => a[a.length - 1 - suf] === segs[0][segs[0].length - 1 - suf])) suf++;
  const join = (a, from, to) => {                                   // segments [from, to) with their own separators
    const sp = a;
    let out = "";
    for (let i = from * 2; i < to * 2 - 1; i++) out += sp[i];
    return out;
  };
  let labels = split.map((a, k) => join(a, pre, segs[k].length - suf).trim() || pageLabel(parts[k]));
  // The same name more than once (a retake of one page): every copy gets its capture time,
  // never "A + A". Numbered only when there is no time to tell them apart.
  const count = {};
  labels.forEach((l) => { count[l.toLowerCase()] = (count[l.toLowerCase()] || 0) + 1; });
  const nth = {};
  labels = labels.map((l, k) => {
    const key = l.toLowerCase();
    if (count[key] < 2) return l;
    nth[key] = (nth[key] || 0) + 1;
    const t = parts[k].stampTime ? new Date(parts[k].stampTime) : null;
    return l + " (" + (t ? t.toLocaleTimeString() : nth[key]) + ")";
  });
  const head = pre ? join(split[0], 0, pre) + split[0][pre * 2 - 1] : "";
  const L = segs[0].length;
  const tail = suf ? split[0][(L - suf) * 2 - 1] + join(split[0], L - suf, L) : "";
  return { title: head + labels.join(" + ") + tail, labels };
}
function relabel(parts) {
  const t = joinTitles(parts);
  return { title: t.title, parts: parts.map((p, i) => (p.label === t.labels[i] ? p : Object.assign({}, p, { label: t.labels[i] }))) };
}
function hostPartOfDoc() { return doc ? doc.parts.find((p) => p.pid === doc.hostPid) || doc.parts[0] : hostPart(); }
function joinedMeta(title, host) {
  const hm = (host && host.legacy && host.legacy.meta) || (host && host.meta) || meta || {};
  return { mode: "joined", title, url: hm.url, env: hm.env, dpr };
}
function partTime(p) { const t = p && p.stampTime; return t ? +new Date(t) : 0; }
// Commit a half-typed text or callout label before the picture changes shape.
function commitOpenInput() {
  const t = document.activeElement;
  if (t && t.classList && t.classList.contains("annot-text-input") && typeof t.blur === "function") t.blur();
}
let lastJoinEntry = null;        // the history entry of the most recent join (its message's Undo)

// One document change - Join, Swap, a layout switch, Match heights, a page's URL bar, Undo join,
// Remove page: one Ctrl+Z, marks moved to where their pages now sit, the Recent row rewritten
// whole on the next flush (D3: in place, never a new row).
//   opts.keepMarks(marks) -> the marks that survive (Undo join drops a removed page's)
//   opts.incoming [{marks, rect}] -> page-local marks arriving with new pages
function changeDoc(label, next, opts) {
  opts = opts || {};
  if (docBusy) return docBusy.then(() => changeDoc(label, next, opts));
  if (next.kind === "joined" && next.parts.length > 1) {         // budget first: refused means nothing changed
    const L = layoutParts(next, { hostDpr: next.dpr, markFloor: next.floor || {} });
    if (!L.fits) return Promise.resolve({ ok: false, reason: L.reason, layout: L });
  }
  if (cropping) endCrop();
  commitOpenInput(); cancelDrag(); liveAnnot = null; activePointerId = null; clearPendingSel();
  const oldRects = pageRects();
  const keep = (opts.keepMarks || ((m) => m))(cloneAnnots(annotations));
  pushDocHistory(label);
  const entry = undoStack[undoStack.length - 1];
  const finish = () => {
    const now = pageRects();
    let marks = remapAnnots(keep, oldRects, now);
    for (const inc of opts.incoming || []) marks = marks.concat(remapAnnots(cloneAnnots(inc.marks || []), [inc.rect], now));
    annotations = marks;
    clearActiveAnnot();
    docDirty = true;
    renderAnnots(); maybeAnnot(); scheduleRecentSave(); markEdited();
    syncDocTitle(); rosterChanged(true);
    return { ok: true, entry };
  };
  const fail = (reason) => {
    if (undoStack[undoStack.length - 1] === entry) undoStack.pop();
    return { ok: false, reason: reason || "Couldn't put the pages together" };
  };
  let r;
  try { r = applyDocState(next); } catch (e) { return Promise.resolve(fail(e && e.message)); }
  if (!r || typeof r.then !== "function") return Promise.resolve(finish());
  docBusy = r.then(finish, (e) => fail(e && e.message)).finally(() => { docBusy = null; });
  return docBusy;
}

// Why this capture cannot take another page right now - or null. The Join button, J, Ctrl+V and
// a dropped file all ask this one question.
function joinBlockedReason() {
  if (jobId && !captureSettled) return "Wait for the capture to finish, then join.";
  if (aborted || !meta || !segments.length) return "Open a capture first, then join another page to it.";
  if (segments.length !== 1) return "This capture is too long to join (saved in " + segments.length + " parts). Capture just the part you need with Area (Alt+Shift+A), then join it.";
  if (cropping) return "Finish or cancel the crop first.";
  if (docBusy) return "Still putting the pages together…";
  return null;
}

// Join pages into this capture. incoming: [{ part, marks (page-local), orderTime? }] where part =
// { src (Blob | canvas), w, h, dpr, meta: {title, url, env}, stampTime, barOn, barBaked,
//   wasCropped?, origin, capKey?, srcEditorId? }. Pages go in capture-time order, oldest first.
async function joinPages(incoming, opts) {
  opts = opts || {};
  if (docBusy) await docBusy;
  const why = joinBlockedReason();
  if (why) return { ok: false, reason: why };
  const base = doc ? doc.parts.slice() : [hostPart()];
  if (!base[0]) return { ok: false, reason: "Open a capture first, then join another page to it." };
  const host = doc ? hostPartOfDoc() : base[0];
  const seq = Date.now().toString(36);
  const added = incoming.map((inc, k) => ({
    part: Object.assign({}, inc.part, { pid: "j" + seq + k, label: undefined }),
    marks: inc.marks || [], orderTime: inc.orderTime != null ? inc.orderTime : partTime(inc.part)
  }));
  // capture-time order, oldest first (left / top); a page with no time goes after this one
  const hostT = partTime(host) || Date.now();
  const rank = (p, t) => ({ p, t: t || (hostT + 1) });
  const ordered = base.map((p) => rank(p, partTime(p))).concat(added.map((a) => rank(a.part, a.orderTime)));
  ordered.sort((u, v) => u.t - v.t);
  const lab = relabel(ordered.map((o) => o.p));
  // 3+ pages joined in ONE action: one under the other when that fits, otherwise side by side.
  // Adding to a picture that is already joined keeps the layout the tester is looking at.
  let dir = opts.dir || (doc ? doc.dir : (lab.parts.length > 2 ? "col" : (joinLayoutPref || "row")));
  const floor = markFloorFor(annotations, pageRects());
  for (const a of added) Object.assign(floor, markFloorFor(a.marks, [{ pid: a.part.pid, x: 0, y: 0, w: a.part.w, h: a.part.h, scale: 1 }]));
  const make = (d, cuts) => ({ kind: "joined", dpr, dir: d, matchHeights: doc ? doc.matchHeights : null,
    matchText: doc ? doc.matchText : false, cuts: cuts || null, floor, parts: lab.parts,
    hostPid: host.pid, meta: joinedMeta(lab.title, host) });
  let next = make(dir);
  let L = layoutParts(next, { hostDpr: dpr, markFloor: floor });
  if (!L.fits && !opts.dir) {                                       // the other direction may fit
    const other = make(dir === "row" ? "col" : "row");
    const L2 = layoutParts(other, { hostDpr: dpr, markFloor: floor });
    if (L2.fits) { next = other; L = L2; }
  }
  if (!L.fits) {                                                    // cut long pages, never above a mark
    const cuts = cutToFit(next, { hostDpr: dpr, markFloor: floor });
    if (!cuts) return { ok: false, reason: "These pages are too long to join. Capture just the part you need with Area (Alt+Shift+A), then join." };
    next = make(next.dir, cuts);
  }
  const incomingMarks = added.filter((a) => a.marks.length)
    .map((a) => ({ marks: a.marks, rect: { pid: a.part.pid, x: 0, y: 0, w: a.part.w, h: a.part.h, scale: 1, bx: 0, by: 0, bw: a.part.w, bh: a.part.h } }));
  const res = await changeDoc(opts.label || "Join", next, { incoming: incomingMarks });
  if (res.ok) lastJoinEntry = res.entry;
  return res;
}
let joinLayoutPref = null;       // the last layout chosen, remembered per machine (milestone 4 persists it)

// A single-capture state for one page of a joined picture. The host page gets its exact
// pre-join state back; a page from elsewhere becomes a capture of its own.
async function singleStateFromPart(p) {
  if (p.legacy) {
    const g = p.legacy;
    return { kind: "single", base: p.src, infoBar: g.infoBar, stampLocked: g.stampLocked, wasCropped: g.wasCropped,
             meta: g.meta, dpr: p.dpr || 1, hostPid: p.pid, stampTime: g.stampTime, captureTime: g.captureTime,
             truncated: g.truncated, sectionCount: g.sectionCount };
  }
  const canvas = (typeof Blob !== "undefined" && p.src instanceof Blob) ? await blobToCanvas(p.src) : p.src;
  return { kind: "single", base: canvas, infoBar: !!p.barOn, stampLocked: !!p.barBaked, wasCropped: !!p.wasCropped,
           meta: Object.assign({ mode: "visible", dpr: p.dpr || 1 }, p.meta || {}), dpr: p.dpr || 1, hostPid: p.pid,
           stampTime: p.stampTime || null, captureTime: null, truncated: false, sectionCount: 1 };
}

// Take pages out of a joined picture - at ANY later time, not only right after the join. Marks on
// a removed page go with it, and so does an arrow that crosses between a removed and a kept page;
// the tester is asked first when that would lose anything.
async function removePages(pids, opts) {
  opts = opts || {};
  if (!doc || cropping) return { ok: false };
  if (docBusy) await docBusy;
  commitOpenInput();
  const gone = new Set(pids);
  const keepParts = doc.parts.filter((p) => !gone.has(p.pid));
  if (!keepParts.length || keepParts.length === doc.parts.length) return { ok: false };
  const rects = pageRects();
  let lost = 0, crossing = 0;
  const drop = new Set();
  annotations.forEach((a, i) => {
    const pg = [...pagesOfMark(a, rects)];
    const inGone = pg.filter((x) => gone.has(x)).length;
    if (!inGone) return;
    if (inGone === pg.length) lost++; else crossing++;
    drop.add(i);
  });
  if ((lost || crossing) && !opts.silent) {
    const names = doc.parts.filter((p) => gone.has(p.pid)).map(pageLabel).join(" and ");
    const bits = [];
    if (lost) bits.push(lost + " mark" + (lost > 1 ? "s" : "") + " on it");
    if (crossing) bits.push(crossing + " arrow" + (crossing > 1 ? "s" : "") + " crossing both pages");
    if (!confirm(names + ": remove it from this image? " + bits.join(" and ") + " go too.")) return { ok: false, cancelled: true };
  }
  if (gone.has(doc.hostPid)) { flushRecentSave(); currentRecentId = null; }   // the row keeps its last joined state
  let next;
  if (keepParts.length === 1) next = await singleStateFromPart(keepParts[0]);
  else {
    const lab = relabel(keepParts);
    const host = keepParts.find((p) => p.pid === doc.hostPid) || keepParts[0];
    next = Object.assign({}, doc, { parts: lab.parts, cuts: null, hostPid: host.pid, meta: joinedMeta(lab.title, host),
                                    floor: markFloorFor(annotations.filter((_, i) => !drop.has(i)), rects) });
  }
  const oldAnnots = annotations;
  return changeDoc(opts.label || (keepParts.length === 1 ? "Undo join" : "Remove page"), next, {
    keepMarks: (m) => m.filter((_, i) => !drop.has(i) && oldAnnots[i] !== undefined)
  });
}
// Back to just this tab's own capture, keeping every mark drawn on it (even after the join).
function undoJoin() {
  if (!doc) return Promise.resolve({ ok: false });
  return removePages(doc.parts.filter((p) => p.pid !== doc.hostPid).map((p) => p.pid));
}

/* ------------------------- Zoom ------------------------- */
function fitScale() {
  const avail = stage.clientWidth - 38;   // 18px padding each side + the 1px host border
  const naturalCss = fullWpx / dpr;
  return Math.max(0.05, Math.min(1, avail / naturalCss));
}
// Total rendered height of the stitched image, in CSS px. Summed across
// segments, because a gigantic page is split into several canvases.
// Keeps the quality track's filled portion in step with its value.
function paintQuality() {
  const q = el("quality");
  if (!q) return;
  const min = parseFloat(q.min), max = parseFloat(q.max), v = parseFloat(q.value);
  if (!isFinite(min) || !isFinite(max) || !isFinite(v) || max === min) return;
  q.style.setProperty("--fill", String((v - min) / (max - min)));
}

function renderedHeight() {
  return segments.reduce((a, s) => a + (parseFloat(s.canvas.style.height) || 0), 0);
}

function applyZoom() {
  const z = zoom === null ? fitScale() : zoom;
  // Rescaling without an anchor drags the document by (scale delta x scroll
  // offset). On an 8214px capture scrolled two thirds down, entering annotate
  // threw the thing you were about to annotate a full screen off the top - you
  // lost your place, then had to hunt for the bug a second time. Hold whatever
  // was in the middle of the viewport instead.
  // A fresh canvas (the URL-bar toggle swaps one in) carries no inline
  // height, so fall back to what the stage is actually scrolling.
  const prevH = renderedHeight() || Math.max(0, stage.scrollHeight - 36);
  const anchor = prevH > 0 ? (stage.scrollTop + stage.clientHeight / 2) / prevH : null;

  for (const s of segments) {
    s.canvas.style.width = (s.canvas.width / dpr) * z + "px";
    s.canvas.style.height = (s.canvas.height / dpr) * z + "px";
  }
  syncAnnotSize();

  if (anchor !== null) {
    const newH = renderedHeight();
    // > 0, never a truthiness test: a NaN here would silently snap an 8000px
    // page back to the top on every frame of a window drag-resize.
    if (newH > 0) stage.scrollTop = Math.max(0, anchor * newH - stage.clientHeight / 2);
  }

  if (cropping && cropOverlay._reset) cropOverlay._reset(); // stale pixel selection after resize
  el("zoomVal").textContent = zoom === null ? "Fit" : Math.round(z * 100) + "%";
  // A zoom mid-gesture (+/-/0, or Fit following a window resize) changes the scale
  // under a held pointer; keep the shape's end on the image point now under it.
  if (edge && edgeLive()) edgeRemap();
}

/* ------------------------- Keyboard & focus ------------------------- */
// Real text entry only: where a letter is a letter and Ctrl+Z undoes typing.
// Sliders, colour pickers, checkboxes and buttons are NOT typing - skipping
// them too left every shortcut dead once a tester had touched Size or Quality.
function isTextEntry(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  const tag = String(t.tagName).toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // A real <input> with no type attribute reports "text"; mirror that.
  return /^(text|search|url|tel|email|password|number|date|datetime-local|month|week|time)$/
    .test(String(t.type || "text").toLowerCase());
}
// A press on the image cancels its pointerdown (no text selection, no image
// drag), and that also cancels Chrome's "a click moves focus" step - so a
// slider or colour picker touched earlier kept the keyboard. Hand it back.
// A label being typed is left alone: its own blur is what commits it.
function releaseControlFocus() {
  const a = document.activeElement;
  if (a && a !== document.body && !isTextEntry(a) && typeof a.blur === "function") a.blur();
}
// A slider used with the MOUSE gives the keyboard back when released, so the
// arrow keys scroll again instead of quietly resizing the live shape. Driven
// from the keyboard (Tab, then arrows) it keeps focus, as it should.
function handBackAfterPointer(input) {
  if (!input) return;
  input.addEventListener("pointerdown", () => {
    window.addEventListener("pointerup", () => setTimeout(() => {
      if (document.activeElement === input) input.blur();
    }, 0), { capture: true, once: true });
  });
}

/* ------------------------- Tools wiring ------------------------- */
function reflectFormat() {
  el("downloadLabel").textContent = "Download " + currentFormat.toUpperCase();
  reflectStatus();
  el("qualityGroup").hidden = !(currentFormat === "jpg" || currentFormat === "pdf");
  // Mark the live format in the list, so opening it answers "which one am I on?"
  const m = el("formatMenu");
  if (m) m.querySelectorAll("button[data-fmt]").forEach((b) => {
    b.setAttribute("aria-current", b.dataset.fmt === currentFormat ? "true" : "false");
  });
}

function wireTools() {
  window.addEventListener("resize", () => { if (zoom === null && segments.length) applyZoom(); });
  document.addEventListener("visibilitychange", () => { const hidden = document.visibilityState === "hidden"; if (hidden) flushRecentSave(); noteVisibility(hidden); });
  window.addEventListener("pagehide", flushRecentSave);
  window.addEventListener("beforeunload", onBeforeUnload);
  el("download").addEventListener("click", () => doDownload(currentFormat));
  el("formatMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const m = el("formatMenu");
    m.hidden = !m.hidden;
  });
  document.addEventListener("click", () => { el("formatMenu").hidden = true; });
  el("formatMenu").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      currentFormat = b.dataset.fmt;
      reflectFormat();
      el("formatMenu").hidden = true;   // the menu only PICKS; the button downloads
    });
  });

  el("quality").addEventListener("input", (e) => {
    quality = parseFloat(e.target.value);
    el("qualityVal").textContent = Math.round(quality * 100) + "%";
    paintQuality();
  });
  handBackAfterPointer(el("quality"));

  el("copy").addEventListener("click", doCopy);
  el("print").addEventListener("click", doPrint);
  el("drive").addEventListener("click", uploadToDrive);
  el("copyLink").addEventListener("click", copyDriveLink);
  el("recentBtn").addEventListener("click", toggleRecent);
  // Click anywhere else (canvas, toolbar, page) closes the drawer, like any popover.
  // Capture phase so it still closes even when the click is handled elsewhere.
  document.addEventListener("pointerdown", (e) => {
    const d = el("recentDrawer"), b = el("recentBtn");
    if (!d || d.hidden) return;
    if (d.contains(e.target) || (b && b.contains(e.target))) return;
    closeRecent();
  }, true);
  window.addEventListener("blur", () => { const d = el("recentDrawer"); if (d && !d.hidden) closeRecent(); });
  try {
    if (chrome.notifications && chrome.notifications.onClicked) {
      chrome.notifications.onClicked.addListener(() => { if (lastDriveLink) window.open(lastDriveLink, "_blank"); });
    }
  } catch (_) {}
  el("infobar").addEventListener("click", toggleInfoBar);
  el("crop").addEventListener("click", startCrop);
  el("cropApply").addEventListener("click", applyCrop);
  el("cropCancel").addEventListener("click", () => { endCrop(); maybeAnnot(); });

  el("zoomIn").addEventListener("click", () => { zoom = Math.min(4, (zoom === null ? fitScale() : zoom) * 1.25); applyZoom(); });
  el("zoomOut").addEventListener("click", () => { zoom = Math.max(0.1, (zoom === null ? fitScale() : zoom) / 1.25); applyZoom(); });
  el("zoomFit").addEventListener("click", () => { zoom = null; applyZoom(); });

  wireAnnotation();

  window.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = String(e.key || "").toLowerCase();   // Chrome's autofill fires keydown with no key
    // Typing in a label: letters, Delete, Ctrl+Z and Ctrl+V all belong to the field.
    // Save and print still mean save and print - blur first so the label commits
    // (its blur handler does that) and is in the file, instead of Chrome's own
    // "Save page as" dialog for the editor page.
    const t = e.target;
    if (isTextEntry(t)) {
      if (ctrl && !e.altKey && (k === "s" || k === "p") && !tools.hidden) {
        e.preventDefault();
        if (typeof t.blur === "function") t.blur();
        if (k === "s") doDownload(currentFormat); else doPrint();
      }
      return;
    }
    if (e.key === "Escape" && el("recentDrawer") && !el("recentDrawer").hidden) { closeRecent(); return; }
    // Delete in the Recent drawer (a card focused) must not erase the live
    // shape hidden behind it.
    if ((e.key === "Delete" || e.key === "Backspace") && t && t.closest && t.closest("#recentDrawer")) return;
    // No image on screen yet (still stitching, the error card, the Recent-only
    // page): a key must not save, print or copy the half-drawn canvas behind it.
    if (tools.hidden) {
      if (ctrl && (k === "s" || k === "p")) {
        e.preventDefault();
        if (!aborted && !captureSettled) toast("Wait for the capture to finish");
      }
      return;
    }
    const click = (id) => { const b = el(id); if (b && !b.disabled) b.click(); };

    // ---- Ctrl combos (work whether or not the annotation bar is open) ----
    if (ctrl && k === "s") { e.preventDefault(); doDownload(currentFormat); return; }
    if (ctrl && k === "p") { e.preventDefault(); doPrint(); return; }
    if (ctrl && k === "c" && !window.getSelection().toString()) { doCopy(); return; }
    if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); annotUndo(); return; }
    if (ctrl && (k === "y" || (e.shiftKey && k === "z"))) { e.preventDefault(); annotRedo(); return; }
    if (ctrl && k === "a") { e.preventDefault(); return; }   // nothing to toggle; nothing to select

    // ---- zoom: plain +/-/0 (Ctrl+= and Ctrl+- belong to the browser, we cannot take them) ----
    if (!ctrl && !e.altKey) {
      if (e.key === "+" || e.key === "=") { e.preventDefault(); click("zoomIn"); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); click("zoomOut"); return; }
      if (e.key === "0") { e.preventDefault(); click("zoomFit"); return; }
    }


    // ---- annotation-only keys ----
    if (annotating) {
      // Esc drops the live shape. It no longer leaves annotate mode - that
      // mode is permanent now, and there would be no way back in.
      if (e.key === "Escape") {
        if (pendingSel) { clearPendingSel(); renderAnnots(); return; }
        if (activeAnnot) clearActiveAnnot();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (commitPendingSel()) { e.preventDefault(); return; }   // Paint: select, then Delete
        if (deleteActiveAnnot()) { e.preventDefault(); return; }
      }
      if (!ctrl && !e.altKey) {
        // [ / ] nudge the size - and because the last shape stays live, this resizes IT
        if (e.key === "[" || e.key === "]") {
          const w = el("awidth");
          if (w) {
            const step = parseFloat(w.step) || 1;
            const next = (parseFloat(w.value) || 1) + (e.key === "]" ? step : -step);
            w.value = String(Math.min(parseFloat(w.max), Math.max(parseFloat(w.min), next)));
            w.dispatchEvent(new Event("input", { bubbles: true }));
            w.dispatchEvent(new Event("change", { bubbles: true }));
          }
          e.preventDefault();
          return;
        }
        // single-letter tool picks, like most drawing apps
        const TOOLKEYS = { v: "select", r: "rect", o: "ellipse", a: "arrow", l: "line", p: "pen", h: "highlight", t: "text", n: "step", b: "blur", c: "callout", s: "stamp", w: "whiteout" };
        const tool = TOOLKEYS[k];
        if (tool) {
          const btn = document.querySelector('.atool[data-tool="' + tool + '"]');
          if (btn) { e.preventDefault(); btn.click(); }
          return;
        }
      }
    }
  });

}

/* ------------------------- Export helpers ------------------------- */
function sanitize(name, max = 80) {
  return (name || "screenshot").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "screenshot";
}
function pad(n) { return String(n).padStart(2, "0"); }
function buildFilename(ext) {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const host = exportHost();
  const cap = doc ? 150 : 80;                 // joined names carry every page; single captures unchanged
  const base = (defaultSettings.filenameTemplate || "{title}-{date}")
    .replace(/{title}/g, sanitize(meta.title, cap))
    .replace(/{date}/g, date)
    .replace(/{time}/g, time)
    .replace(/{host}/g, host || "page");
  return sanitize(base, cap) + "." + ext;
}

function canvasToBlob(canvas, type, q) {
  // toBlob yields null if the encoder fails (out of memory on a very large canvas).
  // Reject with a clear message so callers surface something actionable.
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image too large to encode"))), type, q)
  );
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
        if (chrome.runtime.lastError || id === undefined) reject(chrome.runtime.lastError);
        else resolve(id);
      });
    });
  } catch (_) {
    // Fallback: anchor download
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function doDownload(fmt) {
  try {
    if (fmt === "pdf") return await downloadPdf();
    const type = fmt === "jpg" ? "image/jpeg" : "image/png";
    const ext = fmt === "jpg" ? "jpg" : "png";
    const q = fmt === "jpg" ? quality : undefined;
    if (segments.length === 1) {
      const fc = flatten(segments[0]);
      const blob = await canvasToBlob(fc, type, q);
      await saveBlob(blob, buildFilename(ext));
      recordOwnExport(fc);
      toast("Saved " + ext.toUpperCase());
      markExported();
    } else {
      const stem = buildFilename(ext).slice(0, -(ext.length + 1)); // drop the ".ext" reliably
      for (let i = 0; i < segments.length; i++) {
        const blob = await canvasToBlob(flatten(segments[i]), type, q);
        await saveBlob(blob, `${stem}-part${i + 1}.${ext}`);
      }
      toast(`Saved ${segments.length} ${ext.toUpperCase()} parts`);
      markExported();
    }
  } catch (e) {
    toast("Download failed: " + (e.message || e));
  }
}

// Build the per-page JPEG images for a PDF, with the clickable URL link on page 1.
// Shared by Download-PDF and Send-to-Drive so both PDFs are identical.
async function buildPdfImages() {
  const images = [];
  for (let i = 0; i < segments.length; i++) {
    const fc = flatten(segments[i]);
    const blob = await canvasToBlob(fc, "image/jpeg", quality);
    const image = { jpeg: new Uint8Array(await blob.arrayBuffer()), width: fc.width, height: fc.height };
    const H = fc.height;
    const toPdf = (l) => ({ uri: l.uri, rect: [l.x, H - (l.y + l.h), l.x + l.w, H - l.y] });
    const shown = (l) => !annotations.some((a) => (a.type === "blur" || a.type === "whiteout") &&
      Math.min(a.x1, a.x2) < l.x + l.w && Math.max(a.x1, a.x2) > l.x && Math.min(a.y1, a.y2) < l.y + l.h && Math.max(a.y1, a.y2) > l.y);
    if (i === 0 && doc) {
      const ls = docLinks.filter((l) => l && l.uri && shown(l));
      if (ls.length) image.links = ls.map(toPdf);
    } else if (i === 0 && infoBar && infoBarLink && infoBarLink.uri && shown(infoBarLink)) {
      image.link = toPdf(infoBarLink);
    }
    images.push(image);
  }
  return images;
}

async function downloadPdf() {
  const images = await buildPdfImages();
  const nLinks = images.reduce((a, im) => a + (im.links ? im.links.length : (im.link ? 1 : 0)), 0);
  const linked = nLinks === 1;
  const blob = new Blob([FPCPDF.build(images)], { type: "application/pdf" });
  await saveBlob(blob, buildFilename("pdf"));
  toast(nLinks > 1 ? "Saved PDF: " + nLinks + " URLs are clickable" : linked ? "Saved PDF — URL is clickable" : "Saved PDF");
  markExported();
}

async function doCopy() {
  try {
    const fc = flatten(segments[0]);
    const blob = await canvasToBlob(fc, "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (segments.length === 1) { markExported(); recordCopy(fc); }   // "Copied first section" is not the whole capture
    toast(segments.length > 1 ? "Copied first section" : "Copied to clipboard");
  } catch (e) {
    toast(/too large/.test(e.message || "") ? "Image too large to copy" : "Copy failed (browser blocked it)");
  }
}

let printUrls = [];
async function doPrint() {
  try {
    let area = el("printArea");
    if (!area) {
      area = document.createElement("div");
      area.id = "printArea";
      document.body.appendChild(area);
    }
    cleanupPrint();
    area.innerHTML = "";
    // Use object URLs (not data URLs) to avoid holding huge base64 strings in the DOM.
    for (const s of segments) {
      const blob = await canvasToBlob(flatten(s), "image/png");
      const url = URL.createObjectURL(blob);
      printUrls.push(url);
      const img = new Image();
      img.src = url;
      area.appendChild(img);
    }
    // Give the images a moment to lay out before opening the print dialog.
    await new Promise((r) => setTimeout(r, 250));
    window.print();
  } catch (e) {
    toast(/too large/.test(e.message || "") ? "Image too large to print" : "Couldn’t prepare print");
    cleanupPrint();
  }
}
function cleanupPrint() {
  for (const u of printUrls) URL.revokeObjectURL(u);
  printUrls = [];
  const area = el("printArea");
  if (area) area.innerHTML = "";
}
window.addEventListener("afterprint", cleanupPrint);

/* ------------------------- Crop (single segment) ------------------------- */
let cropping = false, dragStart = null;

function startCrop() {
  if (segments.length !== 1 || docBusy) return;
  exitAnnot();
  cropping = true;
  cropBar.hidden = false;
  cropOverlay.hidden = false;
  cropRect.hidden = true;
  // The overlay uses CSS inset:0, so it always matches the canvas display size at
  // any zoom — no frozen dimensions to go stale.
}
function endCrop() {
  cropping = false;
  cropBar.hidden = true;
  cropOverlay.hidden = true;
  cropRect.hidden = true;
  dragStart = null;
}

cropOverlayEvents();
function cropOverlayEvents() {
  const ov = document.getElementById("cropOverlay");
  const rect = document.getElementById("cropRect");
  let sel = null;

  ov.addEventListener("mousedown", (e) => {
    if (!cropping) return;
    const b = ov.getBoundingClientRect();
    dragStart = { x: e.clientX - b.left, y: e.clientY - b.top };
    sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
    rect.hidden = false;
    updateRect(rect, sel);
    edgeBegin("crop", e);
    e.preventDefault();
    releaseControlFocus();
  });
  // dragStart is in overlay px, so it stays glued to the image while the stage scrolls.
  const moveTo = (clientX, clientY) => {
    const b = ov.getBoundingClientRect();
    const cx = Math.max(0, Math.min(clientX - b.left, b.width));
    const cy = Math.max(0, Math.min(clientY - b.top, b.height));
    sel = { x: Math.min(dragStart.x, cx), y: Math.min(dragStart.y, cy), w: Math.abs(cx - dragStart.x), h: Math.abs(cy - dragStart.y) };
    updateRect(rect, sel);
    const scale = segments[0].canvas.width / segments[0].canvas.getBoundingClientRect().width;
    el("cropInfo").textContent = `${Math.round(sel.w * scale)} × ${Math.round(sel.h * scale)} px`;
  };
  window.addEventListener("mousemove", (e) => {
    if (!cropping || !dragStart) return;
    if (edge && edge.kind === "crop") edgeTrack(e);
    moveTo(e.clientX, e.clientY);
  });
  window.addEventListener("mouseup", () => { dragStart = null; if (edge && edge.kind === "crop") edgeStop(); });
  ov._moveTo = (x, y) => { if (cropping && dragStart) moveTo(x, y); };
  ov._getSel = () => sel;
  // Called when the canvas is resized (zoom / window resize): a pixel selection made
  // at the old display size is no longer valid, so clear it and ask for a fresh drag.
  ov._reset = () => { sel = null; dragStart = null; if (edge && edge.kind === "crop") edgeStop(); rect.hidden = true; el("cropInfo").textContent = "Drag on the image to select a region"; };
}
function updateRect(rect, s) {
  rect.style.left = s.x + "px";
  rect.style.top = s.y + "px";
  rect.style.width = s.w + "px";
  rect.style.height = s.h + "px";
}

function applyCrop() {
  const ov = document.getElementById("cropOverlay");
  const sel = ov._getSel && ov._getSel();
  if (!sel || sel.w < 4 || sel.h < 4) { toast("Draw a bigger selection first"); return; }
  const displayed = segments[0].canvas;      // on-screen canvas (has layout)
  const src = flatten(segments[0]);           // annotations baked in (same pixel dims)
  // Use the same fractional basis (getBoundingClientRect) that the selection was
  // measured against, so the mapping is exact at any zoom. Clamp to source bounds.
  const scale = displayed.width / displayed.getBoundingClientRect().width;
  const sx = Math.max(0, Math.min(src.width, Math.round(sel.x * scale)));
  const sy = Math.max(0, Math.min(src.height, Math.round(sel.y * scale)));
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(sel.w * scale)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(sel.h * scale)));

  const out = document.createElement("canvas");
  out.width = sw; out.height = sh;
  const ctx = out.getContext("2d");
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);

  // One Ctrl+Z brings back the uncropped picture, its live marks and its Recent row. Taken
  // BEFORE the row is flushed and released below, so the entry remembers which row it was.
  pushDocHistory("Crop");
  // Replace the old canvas + annotation layer (annotations are now baked in).
  displayed.remove();
  if (doc) { doc = null; docLayout = null; docLinks = []; }   // the pages are one picture now (undo slice restores)
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; annotCtx = null; }
  // Write the pre-crop markup out against the uncropped image it was actually drawn
  // on, then let go of that Recent row: from here the picture on screen no longer
  // matches the stored blob, so anything drawn next would be saved at crop-space
  // coordinates (and shifted by a bar that is now baked into the pixels).
  flushRecentSave();
  currentRecentId = null;
  if (annotations.length) bakedMarks = true;   // the marks now live only in these pixels
  annotations = [];
  markEdited();
  canvasHost.insertBefore(out, cropOverlay);
  segments = [{ canvas: out, ctx, startY: 0, height: sh }];
  fullWpx = sw; fullHpx = sh;
  // The crop already baked in whatever bar state was showing; freeze the toggle.
  baseSeg0 = out;
  stampLocked = true;
  hostPid = "p" + Date.now().toString(36) + "c";   // a different picture: a new page identity
  infoBarLink = null; // URL position no longer known after a crop; PDF link dropped
  reflectInfoBarBtn();
  wasCropped = true;
  updateDims();
  endCrop();
  applyZoom();
  maybeAnnot();
  toast("Cropped \u00b7 Ctrl+Z undoes it");
}

/* ------------------------- Annotation ------------------------- */
function wireAnnotation() {
  // Colour swatches
  const cont = el("acolors");
  ANNOT_COLORS.forEach((col) => {
    const b = document.createElement("button");
    b.className = "swatch" + (col === annotColor ? " active" : "");
    b.style.background = col;
    b.title = col;
    b.addEventListener("click", () => {
      annotColor = col;
      [...cont.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      applyActiveColour();
    });
    cont.appendChild(b);
  });
  // Tool buttons
  document.querySelectorAll(".atool").forEach((btn) => {
    if (btn.dataset.tool === annotTool) {
      btn.classList.add("active");
      reflectToolName(TOOL_NAMES[annotTool] || annotTool);
      reflectToolSlots();
    }
    btn.addEventListener("click", () => {
      annotTool = btn.dataset.tool;
      reflectToolName(TOOL_NAMES[annotTool] || annotTool);
      clearActiveAnnot(); clearPendingSel();
      applyToolCursor();
      document.querySelectorAll(".atool").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".astamp").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      reflectToolSlots();   // after the sweeps, or it re-arms nothing
    });
  });
  // QA stamp buttons — pick the "stamp" tool with a preset label + colour.
  document.querySelectorAll(".astamp").forEach((btn) => {
    btn.addEventListener("click", () => {
      annotTool = "stamp";
      clearActiveAnnot(); clearPendingSel();
      stampKind = btn.dataset.stamp;
      reflectToolName("Stamp · " + (STAMPS[stampKind] ? STAMPS[stampKind].label : ""));
      reflectToolSlots();
      // A stamp carries its own meaning-colour (see the "stamp" branch of onAnnotDown,
      // which reads STAMPS[stampKind].color directly), so picking one must NOT touch
      // annotColor - doing that silently repainted the next shape you drew in the
      // stamp's colour and left no swatch highlighted.
      document.querySelectorAll(".atool").forEach((b) =>
        b.classList.toggle("active", b.dataset.tool === "stamp"));
      document.querySelectorAll(".astamp").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  // Size: sub-unit steps (the drawn width is annotWidth * dpr, and text/badges scale it
  // by 2.4 again, so whole-number steps jumped far too much). Remembered per machine —
  // the right thickness depends on the display, so chrome.storage.local, not sync.
  const wIn = el("awidth"), wVal = el("awidthVal");
  const reflectWidth = () => {
    if (wVal) wVal.textContent = (annotWidth < 10 && annotWidth === Math.round(annotWidth))
      ? "0" + annotWidth : String(annotWidth);
    if (wIn) wIn.style.setProperty("--fill",
      String((annotWidth - wIn.min) / (wIn.max - wIn.min)));
  };
  wIn.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    annotWidth = (isFinite(v) && v > 0) ? v : 1;
    reflectWidth();
    applyActiveWidth();
  });
  // Persist on release only (input fires continuously while dragging).
  wIn.addEventListener("change", () => {
    try { chrome.storage.local.set({ annotWidth }); } catch (_) {}
  });
  handBackAfterPointer(wIn);
  (async () => {
    try {
      const s = await chrome.storage.local.get("annotWidth");
      const w = s && s.annotWidth;
      if (typeof w === "number" && isFinite(w) && w > 0) { annotWidth = w; wIn.value = String(w); }
    } catch (_) {}
    reflectWidth();
  })();
  const custom = el("acustom");
  if (custom) custom.addEventListener("input", (e) => {
    annotColor = e.target.value;
    [...el("acolors").children].forEach((c) => c.classList.remove("active"));
    applyActiveColour();
  });

  el("aundo").addEventListener("click", annotUndo);
  el("aredo").addEventListener("click", annotRedo);
  el("aclear").addEventListener("click", annotClear);

  // Pointer drawing (delegated on window; active only while annotating)
  window.addEventListener("pointerdown", onAnnotDown);
  window.addEventListener("pointermove", onAnnotMove);
  window.addEventListener("pointerup", onAnnotUp);
  window.addEventListener("pointercancel", onAnnotCancel);
  stage.addEventListener("scroll", onStageScroll, { passive: true });
  window.addEventListener("blur", edgePause);   // pause only: the gesture itself is not ours to end
}

function startAnnot() {
  if (segments.length !== 1) return;
  endCrop();
  if (!annotCanvas) setupAnnotationLayer();
  applyToolCursor();
  annotating = true;
  el("astrip").hidden = false;
  document.querySelector(".work").classList.add("annot");
  canvasHost.classList.add("annotating");
  reflectToolSlots();
  // The rail is always in the flow, so nothing rescales here - but the strip
  // pushes the stage down 40px, and applyZoom's anchor absorbs that.
  applyZoom();
  // Info-bar toggle stays available — toggling now shifts annotations to stay aligned.
}
function exitAnnot() {
  edgeStop();
  annotating = false;
  liveAnnot = null;
  pendingSel = null;
  cancelDrag();
  clearActiveAnnot();
  el("astrip").hidden = true;
  document.querySelector(".work").classList.remove("annot");
  canvasHost.classList.remove("annotating");
  applyZoom();
  renderAnnots();
}

function setupAnnotationLayer() {
  if (segments.length !== 1) return;
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; }
  const base = segments[0].canvas;
  annotCanvas = document.createElement("canvas");
  annotCanvas.className = "annot-layer";
  annotCanvas.width = base.width;
  annotCanvas.height = base.height;
  annotCtx = annotCanvas.getContext("2d");
  canvasHost.insertBefore(annotCanvas, cropOverlay);
  syncAnnotSize();
}

function syncAnnotSize() {
  if (!annotCanvas || !segments[0]) return;
  annotCanvas.style.width = segments[0].canvas.style.width;
  annotCanvas.style.height = segments[0].canvas.style.height;
}

function evtToImg(e) {
  const r = annotCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (annotCanvas.width / r.width),
    y: (e.clientY - r.top) * (annotCanvas.height / r.height)
  };
}

/* ---- Edge auto-scroll ------------------------------------------------------
 * Holding a stroke, a move or a handle drag near the stage edge (or past it)
 * scrolls the stage and re-runs the pointer mapping, so a shape can reach
 * something that is off screen. Bounded on purpose: it arms only after the
 * pointer has really travelled, re-checks the gesture every frame, idles at the
 * scroll limits, and clamps dt so a stalled frame never becomes a jump. It only
 * ever writes scrollTop / scrollLeft - never zoom. */
const EDGE_ZONE = 40;          // CSS px in from the stage's visible edge
const EDGE_SPEED = 960;        // CSS px/s at the edge and past it = fpcSelectRegion's 16 px/frame at 60 Hz
const EDGE_ARM = 4;            // CSS px of real pointer travel before it may start

function edgeBegin(kind, e) {
  edgeStop();
  edge = { kind, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
           armed: false, raf: 0, last: 0, ax: 0, ay: 0, mt: stage.scrollTop, ml: stage.scrollLeft };
}
function edgeStop() {
  if (edge && edge.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(edge.raf);
  edge = null;
}
function edgePause() {
  if (edge && edge.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(edge.raf);
  if (edge) { edge.raf = 0; edge.ax = edge.ay = 0; }
}
// Is the gesture this loop belongs to still the one in progress?
function edgeLive() {
  if (!edge) return false;
  if (edge.kind === "crop") return cropping && !!dragStart;
  if (!annotating || !annotCanvas || edge.id !== activePointerId) return false;
  return !!drag || !!liveAnnot;
}
function edgeTrack(e) {
  if (!edge || e.pointerId !== edge.id || !edgeLive()) return;
  edge.x = e.clientX; edge.y = e.clientY;
  if (!edge.armed && Math.hypot(e.clientX - edge.sx, e.clientY - edge.sy) >= EDGE_ARM) edge.armed = true;
  edge.mt = stage.scrollTop; edge.ml = stage.scrollLeft;   // the caller maps at this scroll
  if (e.buttons === 0) return;                             // the button is already up: never start
  if (edge.armed && !edge.raf) edgeKick();
}
function edgeKick() {
  if (typeof requestAnimationFrame !== "function") return;
  edge.last = 0;
  edge.raf = requestAnimationFrame(edgeTick);
}
// Speed along one axis: 0 outside the zone, easing in across it (the same quadratic
// ramp as the in-page area select, background.js fpcSelectRegion), flat past the edge.
// Negative = toward lo.
function edgeAxis(p, lo, hi) {
  const size = hi - lo;
  if (!(size > 0) || !isFinite(p)) return 0;
  const zone = Math.min(EDGE_ZONE, size / 4);        // a short stage is never all zone
  const inLo = lo + zone - p, inHi = p - (hi - zone);
  const d = inLo > 0 ? inLo : (inHi > 0 ? inHi : 0);
  if (!d) return 0;
  const t = Math.min(1, d / zone);
  return (inLo > 0 ? -1 : 1) * EDGE_SPEED * t * t;
}
function edgeTick(now) {
  if (!edge) return;
  edge.raf = 0;
  if (!edgeLive() || document.hidden) return;
  if (typeof now !== "number") now = Date.now();
  const dt = edge.last ? Math.min(50, Math.max(0, now - edge.last)) : 16;
  edge.last = now;
  const r = stage.getBoundingClientRect();
  const top = r.top + (stage.clientTop || 0), left = r.left + (stage.clientLeft || 0);
  let vy = edgeAxis(edge.y, top, top + stage.clientHeight);
  let vx = edgeAxis(edge.x, left, left + stage.clientWidth);
  const maxT = stage.scrollHeight - stage.clientHeight, maxL = stage.scrollWidth - stage.clientWidth;
  // Only toward an edge the pointer has travelled toward since the press: fine-tuning a
  // handle that sits in the zone, or dragging OUT of a zone, must never scroll.
  if ((vy > 0 && !(edge.y > edge.sy)) || (vy < 0 && !(edge.y < edge.sy))) vy = 0;
  if ((vx > 0 && !(edge.x > edge.sx)) || (vx < 0 && !(edge.x < edge.sx))) vx = 0;
  if ((vy < 0 && stage.scrollTop <= 0) || (vy > 0 && !(stage.scrollTop < maxT - 1))) vy = 0;
  if ((vx < 0 && stage.scrollLeft <= 0) || (vx > 0 && !(stage.scrollLeft < maxL - 1))) vx = 0;
  if (!vx && !vy) { edge.ax = edge.ay = 0; return; }   // out of the zone or at the limit: idle until the pointer moves
  // Whole pixels only, remainder carried: a slow crawl (0.4 px/frame) still arrives.
  edge.ay += vy * dt / 1000; edge.ax += vx * dt / 1000;
  const sy = Math.trunc(edge.ay), sx = Math.trunc(edge.ax);
  edge.ay -= sy; edge.ax -= sx;
  if (sy) stage.scrollTop = Math.max(0, Math.min(maxT, stage.scrollTop + sy));
  if (sx) stage.scrollLeft = Math.max(0, Math.min(maxL, stage.scrollLeft + sx));
  edgeRemap();
  edge.raf = requestAnimationFrame(edgeTick);
}
// Re-run the move with the last real pointer position against the current
// scroll and zoom. Idempotent: every move path is absolute from the press.
function edgeRemap() {
  if (!edgeLive()) return;
  edge.mt = stage.scrollTop; edge.ml = stage.scrollLeft;
  if (edge.kind === "crop") { if (cropOverlay._moveTo) cropOverlay._moveTo(edge.x, edge.y); return; }
  annotMoveTo({ pointerId: edge.id, clientX: edge.x, clientY: edge.y, target: annotCanvas, synthetic: true });
}
// Anything else that scrolls the stage mid-gesture (wheel, keys, applyZoom's anchor).
function onStageScroll() {
  if (edge && edgeLive() && (stage.scrollTop !== edge.mt || stage.scrollLeft !== edge.ml)) edgeRemap();
}

function beginDrag(a, p, e, handle) {
  setActiveAnnot(a);
  if (pendingSel && annotTool !== "whiteout") { clearPendingSel(); }
  activePointerId = e.pointerId;
  try { annotCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  edgeBegin("annot", e);
  drag = { a: a, sx: p.x, sy: p.y, moved: false, handle: handle || null,
    orig: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, bbox: annotBBox(a),
            points: a.points ? a.points.map((q) => ({ x: q.x, y: q.y })) : null } };
  annotCanvas.style.cursor = handle ? (HANDLE_CURSOR[handle] || "move") : "move";
  renderAnnots();
}

function onAnnotDown(e) {
  if (!annotating || !annotCanvas || e.target !== annotCanvas) return;
  if (docBusy) return;                           // the picture is being swapped; wait
  if (e.button !== 0 || !e.isPrimary) return;   // primary mouse button / first touch only
  if (liveAnnot) return;                         // one stroke at a time (ignore extra touches)
  e.preventDefault();
  releaseControlFocus();
  const p = evtToImg(e);
  // A handle of the selected shape wins over everything else: that is a resize.
  if (activeAnnot && annotations.includes(activeAnnot)) {
    const h = handleAt(p, activeAnnot);
    if (h) { beginDrag(activeAnnot, p, e, h.id); return; }
  }
  // Paint-style: the shape you just drew stays live, so pressing on IT moves it -
  // you don't have to switch to the Select tool first. Pressing anywhere else
  // finalises it and starts a new shape as usual.
  if (activeAnnot && annotTool !== "select" && hitTest(p) === activeAnnot) {
    beginDrag(activeAnnot, p, e);
    return;
  }
  clearActiveAnnot();
  if (annotTool === "select") {
    // Click a shape to select it; drag to move it. Click empty space to deselect.
    const hit = hitTest(p);
    if (!hit) { renderAnnots(); return; }
    beginDrag(hit, p, e);
    return;
  }
  if (annotTool === "text") return startText(e, p);
  if (annotTool === "step") { // click-to-drop, auto-numbered
    const a = { type: "step", color: annotColor, width: annotWidth * dpr, x1: p.x, y1: p.y };
    pushHistory();
    annotations.push(a);
    setActiveAnnot(a);
    renderAnnots();
    return;
  }
  if (annotTool === "stamp") { // click-to-drop QA stamp (BUG / PASS / FIXED / RE-TEST)
    const s = STAMPS[stampKind] || STAMPS.bug;
    const a = { type: "stamp", label: s.label, color: s.color, width: annotWidth * dpr, x1: p.x, y1: p.y };
    pushHistory();
    annotations.push(a);
    setActiveAnnot(a);
    renderAnnots();
    return;
  }
  activePointerId = e.pointerId;
  // Capture so we still get the matching up/cancel even if released off-window.
  try { annotCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  liveAnnot = {
    type: annotTool, color: annotColor, width: annotWidth * dpr,
    x1: p.x, y1: p.y, x2: p.x, y2: p.y, points: [p]
  };
  edgeBegin("annot", e);
}
function onAnnotMove(e) {
  edgeTrack(e);
  annotMoveTo(e);
}
function annotMoveTo(e) {
  if (drag && e.pointerId === activePointerId) {
    const p = evtToImg(e);
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    // Snapshot once, on the first real movement, so a plain click leaves no undo entry.
    if (!drag.moved) { if (Math.hypot(dx, dy) < 1) return; drag.moved = true; pushHistory(); activeTouched = true; }
    if (drag.handle) resizeAnnot(drag.a, drag.orig, drag.handle, dx, dy);
    else translateAnnot(drag.a, drag.orig, dx, dy);
    markEdited();
    renderAnnots();
    return;
  }
  if (!annotating) return;
  if (!liveAnnot) {
    // idle hover: show the move cursor over whatever a press would drag
    if (annotCanvas && e.target === annotCanvas) {
      const hp = evtToImg(e);
      const onHandle = (activeAnnot && annotations.includes(activeAnnot)) ? handleAt(hp, activeAnnot) : null;
      if (onHandle) { annotCanvas.style.cursor = HANDLE_CURSOR[onHandle.id] || "move"; return; }
      const over = (annotTool === "select") ? hitTest(hp) : (activeAnnot && hitTest(hp) === activeAnnot ? activeAnnot : null);
      annotCanvas.style.cursor = over ? "move" : ((annotTool === "select") ? "default" : "");
    }
    return;
  }
  if (e.pointerId !== activePointerId) return;
  const p = evtToImg(e);
  liveAnnot.x2 = p.x; liveAnnot.y2 = p.y;
  if (liveAnnot.type === "pen" || liveAnnot.type === "highlight") {
    const q = liveAnnot.points[liveAnnot.points.length - 1];
    if (!e.synthetic || !q || q.x !== p.x || q.y !== p.y) liveAnnot.points.push(p);   // a remap with nothing new adds no point
  }
  renderAnnots();
}
function onAnnotUp(e) {
  if (!e || e.pointerId === activePointerId) edgeStop();
  if (drag && (!e || e.pointerId === activePointerId)) {
    cancelDrag();               // also restores the Select-tool cursor
    renderAnnots();
    return;
  }
  if (!liveAnnot || (e && e.pointerId !== activePointerId)) return;
  const a = liveAnnot; liveAnnot = null; activePointerId = null;
  if (a.type === "callout") { renderAnnots(); return startCalloutText(a); }
  const freehand = a.type === "pen" || a.type === "highlight";
  const trivial = freehand ? a.points.length < 2 : (Math.abs(a.x2 - a.x1) < 3 && Math.abs(a.y2 - a.y1) < 3);
  if (a.type === "whiteout") {
    // Two steps on purpose: you see what you are about to cover before it happens.
    pendingSel = trivial ? null : { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
    clearActiveAnnot();
    reflectHint();
    renderAnnots();
    return;
  }
  if (!trivial) { pushHistory(); annotations.push(a); setActiveAnnot(a); }
  renderAnnots();
}
function onAnnotCancel(e) {
  // Gesture taken over by the browser (scroll / pinch / palm) — discard the stroke.
  if (!e || e.pointerId === activePointerId) edgeStop();
  if (drag && (!e || e.pointerId === activePointerId)) {
    if (drag.moved) translateAnnot(drag.a, drag.orig, 0, 0);   // the gesture was taken over: put it back
    cancelDrag();
    renderAnnots();
    return;
  }
  if (!liveAnnot || (e && e.pointerId !== activePointerId)) return;
  liveAnnot = null; activePointerId = null;
  renderAnnots();
}

function startText(e, p) {
  const scale = annotCanvas.getBoundingClientRect().width / annotCanvas.width; // display px per device px
  const sizeDev = Math.max(16, annotWidth * dpr * 2.4); // font size in device px
  const input = document.createElement("input");
  input.className = "annot-text-input";
  input.type = "text";
  // Anchor to the image point inside the scrolling host, so the box tracks the
  // content if the user scrolls/zooms, and the typed text lines up with the result.
  input.style.left = (p.x * scale) + "px";
  input.style.top = (p.y * scale) + "px";
  input.style.fontSize = Math.max(11, sizeDev * scale) + "px";
  input.style.color = annotColor;
  canvasHost.appendChild(input);
  setTimeout(() => input.focus(), 0);
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const val = input.value.trim();
    input.remove();
    if (val) {
      const ta = { type: "text", color: annotColor, x1: p.x, y1: p.y, size: sizeDev, text: val };
      pushHistory();
      annotations.push(ta);
      setActiveAnnot(ta);
      renderAnnots();
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { input.value = ""; commit(); }
  });
  input.addEventListener("blur", commit);
}

// --- Paint-style "live" shape -------------------------------------------------
// The most recently drawn annotation stays selected, so changing Size (or colour)
// re-applies to IT instead of only affecting the next one. It is finalised as soon
// as you start another shape, switch tool, undo/clear, or leave annotate mode.
function cloneAnnots(list) {
  return list.map((a) => {
    const c = Object.assign({}, a);
    if (a.points) c.points = a.points.map((p) => ({ x: p.x, y: p.y }));
    return c;
  });
}
// The page rectangles in canvas px: where each page's CONTENT sits, below its live bar.
// x/y/w/h/scale = the page CONTENT (below its live bar); bx/by/bw/bh = the whole cell, bar
// included, which decides the page a point belongs to.
function pageRects() {
  if (doc && docLayout) {
    return docLayout.rects.map((r) => ({ pid: r.pid, x: r.cx, y: r.cy, w: r.cw, h: r.ch, scale: r.scale,
                                        bx: r.x, by: r.y, bw: r.w, bh: r.h }));
  }
  const b = baseSeg0 || (segments[0] && segments[0].canvas);
  const y = (b && infoBar && !stampLocked) ? infoBarHeight() : 0;
  const w = b ? b.width : 0, h = b ? b.height : 0;
  return [{ pid: hostPid, x: 0, y, w, h, scale: 1, bx: 0, by: 0, bw: w, bh: h + y }];
}
function snapAnnots() { const s = cloneAnnots(annotations); s.rects = pageRects(); return s; }
function captureDoc() {
  if (doc) return doc;          // immutable: a change always builds a new document object
  return { kind: "single", base: baseSeg0, infoBar, stampLocked, wasCropped, meta, dpr, hostPid, stampTime,
           captureTime, truncated, sectionCount };
}
function snapDoc(label) {
  const s = snapAnnots(); s.doc = captureDoc(); s.rid = currentRecentId; s.label = label || ""; return s;
}
function pushEntry(s) {
  undoStack.push(s);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  scheduleRecentSave();
  markEdited();
}
// Call BEFORE mutating `annotations` so undo can restore the previous state.
function pushHistory() { pushEntry(snapAnnots()); }
// Call BEFORE a document change. One Ctrl+Z brings back the picture, its marks and its Recent row.
function pushDocHistory(label) { pushEntry(snapDoc(label)); }
function shiftAnnotXY(a, dx, dy) {
  if (typeof a.x1 === "number") a.x1 += dx;
  if (typeof a.x2 === "number") a.x2 += dx;
  if (typeof a.y1 === "number") a.y1 += dy;
  if (typeof a.y2 === "number") a.y2 += dy;
  if (a.points) for (const p of a.points) { p.x += dx; p.y += dy; }
}
function nearestRect(rects, x, y) {
  let best = null, bd = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = r; }
  }
  return best;
}
// The page a point belongs to: inside a cell (bar included) wins, otherwise the nearest cell -
// so a mark on the grey seam goes with the page it is closest to.
function pageOfPoint(rects, x, y) {
  let best = null, bd = Infinity;
  for (const r of rects) {
    const bx = r.bx != null ? r.bx : r.x, by = r.by != null ? r.by : r.y;
    const bw = r.bw != null ? r.bw : r.w, bh = r.bh != null ? r.bh : r.h;
    const dx = Math.max(bx - x, 0, x - (bx + bw)), dy = Math.max(by - y, 0, y - (by + bh));
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = r; }
  }
  return best;
}
function movePoint(x, y, f, t) {
  const sf = f.scale || 1, st = t.scale || 1;
  return { x: t.x + (x - f.x) / sf * st, y: t.y + (y - f.y) / sf * st };
}
function markCentre(a) {
  if (a.points && a.points.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of a.points) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }
  if (a.x2 != null && a.type !== "callout") return { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2 };
  return { x: a.x1, y: a.y1 };
}
const hasEnds = (a) => (a.type === "arrow" || a.type === "line" || a.type === "callout") && a.x2 != null;
// Move marks from the page rectangles they were drawn against to where those pages sit now.
// Arrow, line and callout ends go END BY END, so an arrow drawn from page A to page B keeps
// pointing at the same two things after Swap, a layout change or Undo join. A pen stroke moves
// with the page under its middle; everything else with the page under its centre. A mark whose
// page is not in `to` is left alone (callers drop marks of removed pages first).
function remapAnnots(list, from, to) {
  if (!from || !to || !from.length || !to.length) return list;
  const target = (r) => r && to.find((q) => q.pid === r.pid);
  for (const a of list) {
    if (hasEnds(a)) {
      const f1 = pageOfPoint(from, a.x1, a.y1), t1 = target(f1);
      const f2 = pageOfPoint(from, a.x2, a.y2), t2 = target(f2);
      if (t1) { const p = movePoint(a.x1, a.y1, f1, t1); a.x1 = p.x; a.y1 = p.y; }
      if (t2) { const p = movePoint(a.x2, a.y2, f2, t2); a.x2 = p.x; a.y2 = p.y; }
      continue;
    }
    const c = markCentre(a);
    const f = pageOfPoint(from, c.x, c.y), t = target(f);
    if (!t || (t.x === f.x && t.y === f.y && (t.scale || 1) === (f.scale || 1))) continue;
    const p1 = movePoint(a.x1, a.y1, f, t); a.x1 = p1.x; a.y1 = p1.y;
    if (a.x2 != null) { const p2 = movePoint(a.x2, a.y2, f, t); a.x2 = p2.x; a.y2 = p2.y; }
    if (a.points) a.points = a.points.map((q) => movePoint(q.x, q.y, f, t));
  }
  return list;
}
// The pages a mark touches (for Undo join / Remove page: which marks go with a page).
function pagesOfMark(a, rects) {
  const out = new Set();
  const add = (r) => { if (r) out.add(r.pid); };
  if (hasEnds(a)) { add(pageOfPoint(rects, a.x1, a.y1)); add(pageOfPoint(rects, a.x2, a.y2)); }
  else { const c = markCentre(a); add(pageOfPoint(rects, c.x, c.y)); }
  return out;
}
// {pid: the lowest point any mark reaches on that page, in page-content SOURCE px}. Match heights
// and Cut to fit never cut above it.
function markFloorFor(list, rects) {
  const floor = {};
  const note = (r, y) => { if (!r) return; const v = (y - r.y) / (r.scale || 1); if (!(floor[r.pid] >= v)) floor[r.pid] = v; };
  for (const a of list) {
    const half = (a.width || 0) / 2;
    if (hasEnds(a)) {
      note(pageOfPoint(rects, a.x1, a.y1), a.y1 + half);
      note(pageOfPoint(rects, a.x2, a.y2), a.y2 + half);
      continue;
    }
    const c = markCentre(a);
    let bottom = c.y;
    try { const b = annotBBox(a); if (b) bottom = b.y + b.h; } catch (_) {}
    note(pageOfPoint(rects, c.x, c.y), bottom + half);
  }
  return floor;
}

// ---- Paint-style area selection -------------------------------------------
// The White out tool drags a marquee; Delete turns it into a real block. Keeping the
// marquee OUT of the annotations list means it can never be exported, undone, or left
// behind as an invisible empty shape.
function drawMarquee(ctx, x, y, w, h) {
  const s = screenScale();
  ctx.save();
  ctx.fillStyle = "rgba(20,184,166,.10)";
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1 * s;
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(15,23,42,.65)";
  ctx.strokeRect(x + 0.5 * s, y + 0.5 * s, w - s, h - s);
  ctx.setLineDash([5 * s, 4 * s]);
  ctx.strokeStyle = "rgba(255,255,255,.95)";
  ctx.strokeRect(x + 0.5 * s, y + 0.5 * s, w - s, h - s);
  ctx.restore();
}

function clearPendingSel() { pendingSel = null; reflectHint(); }

function commitPendingSel() {
  if (!pendingSel) return false;
  const s = pendingSel;
  pendingSel = null;
  pushHistory();
  const a = { type: "whiteout", color: annotColor, width: annotWidth * dpr,
              x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
  annotations.push(a);
  setActiveAnnot(a);          // selected, so it can be moved, resized, or deleted again
  renderAnnots();
  return true;
}

// The hint line does double duty: it says Delete is the next step while an area is
// picked, and goes back to the move/resize hint once something is selected.
function reflectHint() {
  const h = el("ahint");
  if (!h) return;
  if (pendingSel) {
    h.textContent = "Press Delete to white out this area · Esc to cancel";
    h.hidden = false;
    return;
  }
  h.textContent = "Drag to move · size & colour apply to it";
  h.hidden = !activeAnnot;
}

function reflectActive() { reflectHint(); }
function setActiveAnnot(a) { activeAnnot = a || null; activeTouched = false; reflectActive(); }
function clearActiveAnnot() {
  const had = !!activeAnnot;
  activeAnnot = null; activeTouched = false; reflectActive();
  if (had && annotCtx) renderAnnots();          // drop the dashed outline immediately
}
function touchActive() { if (!activeTouched) { pushHistory(); activeTouched = true; } }
// The Select tool's drag must be dropped by anything that replaces or removes the
// dragged object (undo/redo/delete/clear/leaving annotate), or it keeps moving a ghost.
function cancelDrag() {
  if (!drag) return;
  edgeStop();
  try { if (annotCanvas && activePointerId != null) annotCanvas.releasePointerCapture(activePointerId); } catch (_) {}
  drag = null; activePointerId = null;
  applyToolCursor();
}
function applyToolCursor() { if (annotCanvas) annotCanvas.style.cursor = (annotTool === "select") ? "default" : ""; }
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255 > 0.62;
}
function deleteActiveAnnot() {
  cancelDrag();
  if (!activeAnnot) return false;
  const i = annotations.indexOf(activeAnnot);
  if (i >= 0) { pushHistory(); annotations.splice(i, 1); }
  clearActiveAnnot();
  renderAnnots();
  return true;
}
function applyActiveWidth() {
  if (!activeAnnot) return;
  // text / callout carry a font size; everything else uses the stroke width
  const isLabel = activeAnnot.type === "text" || activeAnnot.type === "callout";
  const next = isLabel ? Math.max(16, annotWidth * dpr * 2.4) : annotWidth * dpr;
  if ((isLabel ? activeAnnot.size : activeAnnot.width) === next) return;   // no change, no undo step
  touchActive();
  markEdited();              // touchActive pushes history only once per live-edit session
  if (isLabel) activeAnnot.size = next; else activeAnnot.width = next;
  renderAnnots();
}
function applyActiveColour() {
  if (!activeAnnot || activeAnnot.type === "stamp") return;  // stamps keep their meaning-colour
  if (activeAnnot.color === annotColor) return;
  touchActive();
  markEdited();
  activeAnnot.color = annotColor;
  renderAnnots();
}

/* ---- Select / move: geometry helpers ---- */
function labelMetrics(a) {
  // Same maths as drawAnnot, so the box we test/outline is the box that gets drawn.
  const ctx = annotCtx; ctx.save();
  let m;
  if (a.type === "text") {
    ctx.font = `600 ${a.size}px system-ui, "Segoe UI", Arial, sans-serif`;
    m = { w: ctx.measureText(a.text || "").width, h: a.size };
  } else if (a.type === "stamp") {
    const fs = Math.max(15, (a.width || 6) * 2.4);
    ctx.font = `800 ${Math.round(fs)}px system-ui, "Segoe UI", Arial, sans-serif`;
    m = { w: Math.round(ctx.measureText(a.label || "BUG").width + Math.round(fs * 0.55) * 2), h: Math.round(fs + Math.round(fs * 0.34) * 2) };
  } else {                                   // callout
    const fs = a.size || 20;
    ctx.font = `700 ${Math.round(fs)}px system-ui, "Segoe UI", Arial, sans-serif`;
    m = { w: Math.round(ctx.measureText(a.text || "").width + Math.round(fs * 0.55) * 2), h: Math.round(fs + Math.round(fs * 0.42) * 2) };
  }
  ctx.restore();
  return m;
}
function annotBBox(a) {
  switch (a.type) {
    case "pen": case "highlight": {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of a.points || []) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (!isFinite(x0)) return { x: a.x1, y: a.y1, w: 0, h: 0 };
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    case "text": case "stamp": case "callout": { const m = labelMetrics(a); return { x: a.x1, y: a.y1, w: m.w, h: m.h }; }
    case "step": { const r = Math.max(14, (a.width || 6) * 2.4); return { x: a.x1 - r, y: a.y1 - r, w: 2 * r, h: 2 * r }; }
    default: { const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2); return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) }; }
  }
}
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
// image-px per screen-px, so click tolerance and outline thickness stay constant on screen
function screenScale() { const r = annotCanvas.getBoundingClientRect(); return r.width ? annotCanvas.width / r.width : 1; }
function hitTest(p) {
  const tol = 8 * screenScale();
  for (let i = annotations.length - 1; i >= 0; i--) {         // topmost first
    const a = annotations[i];
    const half = (a.width || 6) / 2;
    if (a.type === "line" || a.type === "arrow") {
      if (distToSeg(p.x, p.y, a.x1, a.y1, a.x2, a.y2) <= half + tol) return a;
      continue;
    }
    if (a.type === "pen" || a.type === "highlight") {
      const pts = a.points || [], w = a.type === "highlight" ? half * 2.4 : half;
      for (let k = 1; k < pts.length; k++) if (distToSeg(p.x, p.y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= w + tol) return a;
      continue;
    }
    const b = annotBBox(a);
    const pad = (a.type === "rect" || a.type === "ellipse" || a.type === "blur" || a.type === "whiteout") ? half + tol : tol;
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return a;
    if (a.type === "callout" && a.text && a.x2 != null) {    // ...or on its tail
      const tailW = Math.max(6, (a.size || 20) * 0.32);
      if (distToSeg(p.x, p.y, b.x + b.w / 2, b.y + b.h / 2, a.x2, a.y2) <= tailW + tol) return a;
    }
  }
  return null;
}
// --- resize handles ---------------------------------------------------------
// Box shapes get 8 handles, lines/arrows get one per end, freehand gets 4 corners
// (proportional scale). Text / stamps / step badges / callouts size by font, so the
// Size slider (and [ / ]) is their handle - they get none.
const HANDLE_CURSOR = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", p1: "move", p2: "move" };

function handlesFor(a) {
  if (!a) return [];
  if (a.type === "line" || a.type === "arrow") {
    return [{ id: "p1", x: a.x1, y: a.y1 }, { id: "p2", x: a.x2, y: a.y2 }];
  }
  if (a.type === "text" || a.type === "stamp" || a.type === "callout" || a.type === "step") return [];
  const b = annotBBox(a);
  const mx = b.x + b.w / 2, my = b.y + b.h / 2, r = b.x + b.w, bt = b.y + b.h;
  if (a.type === "pen" || a.type === "highlight") {
    return [{ id: "nw", x: b.x, y: b.y }, { id: "ne", x: r, y: b.y }, { id: "se", x: r, y: bt }, { id: "sw", x: b.x, y: bt }];
  }
  return [
    { id: "nw", x: b.x, y: b.y }, { id: "n", x: mx, y: b.y }, { id: "ne", x: r, y: b.y },
    { id: "e", x: r, y: my }, { id: "se", x: r, y: bt }, { id: "s", x: mx, y: bt },
    { id: "sw", x: b.x, y: bt }, { id: "w", x: b.x, y: my }
  ];
}

function handleAt(p, a) {
  const tol = 9 * screenScale();
  for (const h of handlesFor(a)) {
    if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h;
  }
  return null;
}

// Apply a handle drag. `orig` is the pre-drag geometry captured in beginDrag.
function resizeAnnot(a, orig, id, dx, dy) {
  if (id === "p1") { a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy; return; }
  if (id === "p2") { a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy; return; }
  const b = orig.bbox;
  let x = b.x, y = b.y, w = b.w, h = b.h;
  if (id.indexOf("w") >= 0) { x = b.x + dx; w = b.w - dx; }
  if (id.indexOf("e") >= 0) { w = b.w + dx; }
  if (id.indexOf("n") >= 0) { y = b.y + dy; h = b.h - dy; }
  if (id.indexOf("s") >= 0) { h = b.h + dy; }
  const min = 6 * screenScale();
  if (w < min) { if (id.indexOf("w") >= 0) x = b.x + b.w - min; w = min; }
  if (h < min) { if (id.indexOf("n") >= 0) y = b.y + b.h - min; h = min; }
  if (a.type === "pen" || a.type === "highlight") {
    // scale every point about the corner that stayed put
    const ax = (id.indexOf("w") >= 0) ? b.x + b.w : b.x;
    const ay = (id.indexOf("n") >= 0) ? b.y + b.h : b.y;
    const nax = (id.indexOf("w") >= 0) ? x + w : x;
    const nay = (id.indexOf("n") >= 0) ? y + h : y;
    const sx = b.w > 0.01 ? w / b.w : 1, sy = b.h > 0.01 ? h / b.h : 1;
    a.points = (orig.points || []).map((q) => ({ x: nax + (q.x - ax) * sx, y: nay + (q.y - ay) * sy }));
    a.x1 = x; a.y1 = y; a.x2 = x + w; a.y2 = y + h;
    return;
  }
  a.x1 = x; a.y1 = y; a.x2 = x + w; a.y2 = y + h;
}

function translateAnnot(a, orig, dx, dy) {
  a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy;
  if (orig.x2 != null) { a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy; }
  if (orig.points) a.points = orig.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
}

// After dragging a callout (bubble anchor -> what it points at), ask for the text.
function startCalloutText(a) {
  const scale = annotCanvas.getBoundingClientRect().width / annotCanvas.width;
  const sizeDev = Math.max(16, annotWidth * dpr * 2.4);
  const input = document.createElement("input");
  input.className = "annot-text-input";
  input.type = "text";
  input.placeholder = "Comment...";
  input.style.left = (a.x1 * scale) + "px";
  input.style.top = (a.y1 * scale) + "px";
  input.style.fontSize = Math.max(11, sizeDev * scale) + "px";
  input.style.color = isLight(a.color) ? "#111827" : a.color;
  canvasHost.appendChild(input);
  setTimeout(() => input.focus(), 0);
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const val = input.value.trim();
    input.remove();
    if (val) {
      const ca = { type: "callout", color: a.color, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, size: sizeDev, text: val };
      pushHistory();
      annotations.push(ca);
      setActiveAnnot(ca);
    }
    renderAnnots();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    else if (ev.key === "Escape") { input.value = ""; commit(); }
  });
  input.addEventListener("blur", commit);
}

function renderAnnots() {
  if (!annotCtx) return;
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  stepNums = stepNumbers(annotations, docLayout && docLayout.rects);
  for (const a of annotations) drawAnnot(a);
  if (liveAnnot && !exportingAnnots) drawAnnot(liveAnnot);   // uncommitted stroke never exports
  // The pending area: a marquee only, no ink.
  if (pendingSel && !exportingAnnots) {
    const px = Math.min(pendingSel.x1, pendingSel.x2), py = Math.min(pendingSel.y1, pendingSel.y2);
    drawMarquee(annotCtx, px, py, Math.abs(pendingSel.x2 - pendingSel.x1), Math.abs(pendingSel.y2 - pendingSel.y1));
  }
  // Dashed outline around the selected / live shape. Screen-only: flatten() re-renders
  // with exportingAnnots=true, so this never reaches a download, copy or Drive upload.
  if (activeAnnot && !exportingAnnots && annotations.includes(activeAnnot)) {
    const b = annotBBox(activeAnnot), s = screenScale(), pad = 6 * s;
    const ctx = annotCtx; ctx.save();
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = "rgba(20,184,166,.95)";
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
    const hs = 4.5 * s;                       // handle half-size, constant on screen
    for (const h of handlesFor(activeAnnot)) {
      ctx.fillStyle = "#fff";
      ctx.lineWidth = 1.5 * s;
      ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    }
    ctx.restore();
  }
}

function drawAnnot(a) {
  const ctx = annotCtx;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width || 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
  switch (a.type) {
    case "rect":
      ctx.strokeRect(x, y, w, h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    case "line":
      ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
      break;
    case "arrow":
      drawArrow(ctx, a);
      break;
    case "pen":
      drawPath(ctx, a.points);
      break;
    case "highlight":
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (a.width || 6) * 2.4;
      drawPath(ctx, a.points);
      break;
    case "text":
      ctx.font = `600 ${a.size}px system-ui, "Segoe UI", Arial, sans-serif`;
      ctx.textBaseline = "top";
      // subtle outline so text is readable on any background
      ctx.lineWidth = Math.max(2, a.size / 8);
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.strokeText(a.text, a.x1, a.y1);
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, a.x1, a.y1);
      break;
    case "blur":
      drawBlur(ctx, x, y, w, h, a.width);
      break;
    case "whiteout": {
      // While the drag is still in flight this is only a SELECTION - Paint does not
      // paint until you press Delete, and neither do we.
      if (a === liveAnnot) { drawMarquee(ctx, x, y, w, h); break; }
      // A solid block that removes a distraction. Deliberately NOT the redaction
      // tool: blur leaves a visible "something was hidden here", which is what a
      // bug report should show.
      ctx.fillStyle = "#ffffff";
      forEachPageClip(x, y, w, h, (px, py, pw, ph) => ctx.fillRect(px, py, pw, ph));
      break;
    }
    case "step": {
      // Auto-numbered by position among step badges (so undo/redo renumbers cleanly).
      const n = (stepNums && stepNums.get(a)) || (annotations.filter((s) => s.type === "step").length + 1);
      const r = Math.max(14, (a.width || 6) * 2.4);
      ctx.beginPath();
      ctx.arc(a.x1, a.y1, r, 0, 2 * Math.PI);
      ctx.fillStyle = a.color; ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.12); ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(n), a.x1, a.y1 + r * 0.06);
      break;
    }
    case "callout": {
      // While dragging there is no text yet - just preview the leader line.
      if (!a.text) {
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = Math.max(2, (a.width || 6) * 0.5);
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      const cfs = a.size || 20;
      ctx.font = `700 ${Math.round(cfs)}px system-ui, "Segoe UI", Arial, sans-serif`;
      const cpadX = Math.round(cfs * 0.55), cpadY = Math.round(cfs * 0.42);
      const ctw = ctx.measureText(a.text).width;
      const cbw = Math.round(ctw + cpadX * 2), cbh = Math.round(cfs + cpadY * 2);
      const cbx = a.x1, cby = a.y1;
      const crr = Math.round(Math.min(cbh * 0.35, 14));
      // Tail first, so the bubble covers its base.
      const mx = cbx + cbw / 2, my = cby + cbh / 2;
      const ddx = (a.x2 == null ? mx : a.x2) - mx, ddy = (a.y2 == null ? my : a.y2) - my;
      const outside = Math.abs(ddx) > cbw / 2 + 2 || Math.abs(ddy) > cbh / 2 + 2;
      if (outside) {
        const t = Math.min((cbw / 2) / Math.max(0.001, Math.abs(ddx)), (cbh / 2) / Math.max(0.001, Math.abs(ddy)));
        const ex = mx + ddx * t, ey = my + ddy * t;          // where the tail leaves the bubble
        const ang = Math.atan2(ddy, ddx);
        const half = Math.max(6, cfs * 0.32);
        ctx.beginPath();
        ctx.moveTo(ex - Math.sin(ang) * half, ey + Math.cos(ang) * half);
        ctx.lineTo(ex + Math.sin(ang) * half, ey - Math.cos(ang) * half);
        ctx.lineTo(a.x2, a.y2);
        ctx.closePath();
        ctx.fillStyle = a.color; ctx.fill();
      }
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cbx, cby, cbw, cbh, crr); else ctx.rect(cbx, cby, cbw, cbh);
      ctx.fillStyle = a.color; ctx.fill();
      const light = isLight(a.color);
      ctx.lineWidth = Math.max(2, Math.round(cfs * 0.08));
      ctx.strokeStyle = light ? "rgba(17,24,39,.6)" : "rgba(255,255,255,.92)"; ctx.stroke();
      ctx.fillStyle = light ? "#111827" : "#fff";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(a.text, cbx + cpadX, cby + cbh / 2 + Math.round(cfs * 0.03));
      break;
    }
    case "stamp": {
      const fs = Math.max(15, (a.width || 6) * 2.4);
      ctx.font = `800 ${Math.round(fs)}px system-ui, "Segoe UI", Arial, sans-serif`;
      const label = a.label || "BUG";
      const padX = Math.round(fs * 0.55), padY = Math.round(fs * 0.34);
      const tw = ctx.measureText(label).width;
      const bw = Math.round(tw + padX * 2), bh = Math.round(fs + padY * 2);
      const rr = Math.round(bh * 0.28);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(a.x1, a.y1, bw, bh, rr);
      else ctx.rect(a.x1, a.y1, bw, bh);
      ctx.fillStyle = a.color; ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(fs * 0.08)); ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(label, a.x1 + padX, a.y1 + bh / 2 + Math.round(fs * 0.03));
      break;
    }
  }
  ctx.restore();
}

function drawArrow(ctx, a) {
  ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = Math.max(12, (a.width || 6) * 3.2);
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(a.x2 - len * Math.cos(ang - Math.PI / 7), a.y2 - len * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(a.x2 - len * Math.cos(ang + Math.PI / 7), a.y2 - len * Math.sin(ang + Math.PI / 7));
  ctx.closePath(); ctx.fill();
}

function drawPath(ctx, pts) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

// On a joined image a blur is applied per page, so it never samples the grey seam or the
// neighbouring page (a redaction must pixelate what it covers, nothing else).
function drawBlur(ctx, x, y, w, h, strength) {
  forEachPageClip(x, y, w, h, (px, py, pw, ph) => blurRegion(ctx, px, py, pw, ph, strength));
}
function forEachPageClip(x, y, w, h, fn) {
  if (!docLayout) return fn(x, y, w, h);
  for (const r of docLayout.rects) {
    const x0 = Math.max(x, r.x), y0 = Math.max(y, r.y);
    const x1 = Math.min(x + w, r.x + r.w), y1 = Math.min(y + h, r.y + r.h);
    if (x1 - x0 > 0 && y1 - y0 > 0) fn(x0, y0, x1 - x0, y1 - y0);
  }
}
function blurRegion(ctx, x, y, w, h, strength) {
  const base = segments[0] && segments[0].canvas;
  if (!base || w < 2 || h < 2) return;
  // Clamp to base bounds. Trim the width/height by however much the origin
  // moved, or a selection started off-canvas would keep its full extent.
  const x0 = x, y0 = y;
  x = Math.max(0, Math.min(base.width - 1, x));
  y = Math.max(0, Math.min(base.height - 1, y));
  w = Math.min(base.width - x, w - (x - x0));
  h = Math.min(base.height - y, h - (y - y0));
  if (w < 2 || h < 2) return;
  // The Size control drives the block size. It used to be derived from the
  // SELECTION instead, so the slider did nothing on a blur.
  // The floor of 8 is not a preference: below it, 11px text starts to be
  // readable again, and this is the control people redact passwords with.
  const want = Math.max(8, Math.min(48, Math.round((strength || 8) * 1.5)));
  // ...but a block that is large next to a THIN selection averages the strip
  // to one flat colour, which reads as "nothing happened" rather than as a
  // redaction. Keep at least three blocks across the short side.
  const block = Math.min(want, Math.max(8, Math.floor(Math.min(w, h) / 3)));
  const tw = Math.max(1, Math.round(w / block));
  const th = Math.max(1, Math.round(h / block));
  const tmp = document.createElement("canvas");
  tmp.width = tw; tmp.height = th;
  tmp.getContext("2d").drawImage(base, x, y, w, h, 0, 0, tw, th);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

function annotUndo() { return stepHistory(-1); }
function annotRedo() { return stepHistory(1); }
function stepHistory(dir) {
  if (docBusy) return docBusy.then(() => stepHistory(dir));   // presses queue in order
  cancelDrag();
  const from = dir < 0 ? undoStack : redoStack, to = dir < 0 ? redoStack : undoStack;
  if (!from.length) return;
  const e = from.pop();
  if (e.doc) { to.push(snapDoc(e.label)); return restoreDoc(e, from, to); }
  to.push(snapAnnots());
  annotations = remapAnnots(e.slice(), e.rects, pageRects());
  clearActiveAnnot();            // the snapshot holds fresh objects; the old reference is stale
  renderAnnots();
  scheduleRecentSave();
  markEdited();
}
function restoreDoc(e, from, to) {
  if (cropping) endCrop();
  liveAnnot = null; activePointerId = null; clearPendingSel(); clearActiveAnnot();
  if (e.rid !== currentRecentId) flushRecentSave();   // the row being left keeps its final state
  const finish = () => {
    annotations = remapAnnots(e.slice(), e.rects, pageRects());
    currentRecentId = e.rid;
    docDirty = true;
    renderAnnots();
    maybeAnnot();
    scheduleRecentSave();
    markEdited();
    syncDocTitle(); rosterChanged(true);
  };
  let r;
  try { r = applyDocState(e.doc); } catch (err) { to.pop(); from.push(e); toast("Couldn't undo that step"); return; }
  if (!r || typeof r.then !== "function") { finish(); return; }
  docBusy = r.then(finish, () => { to.pop(); from.push(e); toast("Couldn't undo that step"); })
    .finally(() => { docBusy = null; });
  return docBusy;
}
// Puts back a picture state captured by captureDoc(). A single capture is synchronous; a joined
// picture composes from its pages (async). NOT the page model's applyDoc(next, opts), which
// this calls for joined states - two functions of one name silently kept only the later one.
function applyDocState(d) {
  if (d.kind === "joined") return applyJoinedDoc(d);
  applySingleDoc(d);
}
function applyJoinedDoc(d) {
  return applyDoc(d, {}).then((res) => {
    if (!res || !res.ok) throw new Error((res && res.reason) || "Couldn't put the pages together");
    return res;
  });
}
// Synchronous: every canvas it needs is in hand (the entry pinned the pristine one).
function applySingleDoc(d) {
  const oldC = segments[0] && segments[0].canvas;
  for (const seg of segments) seg.canvas.remove();
  doc = null; docLayout = null; docLinks = [];
  if ("captureTime" in d) captureTime = d.captureTime;
  if ("truncated" in d) truncated = d.truncated;
  if ("sectionCount" in d) sectionCount = d.sectionCount;
  baseSeg0 = d.base; infoBar = d.infoBar; stampLocked = d.stampLocked; wasCropped = d.wasCropped;
  meta = d.meta; dpr = d.dpr; hostPid = d.hostPid;
  if (d.stampTime) stampTime = d.stampTime;
  const live = infoBar && !stampLocked;
  const shown = live ? withInfoBar(baseSeg0) : baseSeg0;   // redrawn bar prints the frozen stampTime
  if (!live) infoBarLink = null;
  canvasHost.insertBefore(shown, cropOverlay);
  segments = [{ canvas: shown, ctx: shown.getContext("2d"), startY: 0, height: shown.height }];
  fullWpx = baseSeg0.width; fullHpx = baseSeg0.height;
  if (oldC && oldC._fpcComposite && oldC !== shown && oldC !== baseSeg0) { oldC.width = 0; oldC.height = 0; }
  if (annotCanvas || annotating) setupAnnotationLayer();
  el("crop").disabled = false;
  reflectInfoBarBtn(); updateDims(); applyZoom();
}
function annotClear() {
  cancelDrag();
  if (docBusy || !annotations.length) return;
  pushHistory();
  clearActiveAnnot();
  annotations = [];
  renderAnnots();
}

// Returns a canvas with annotations baked in, or the raw segment canvas if none.
function flatten(seg) {
  if (!annotCanvas || annotations.length === 0 || seg !== segments[0]) return seg.canvas;
  // Re-render without the on-screen-only selection outline, so it can never be
  // baked into a download / clipboard copy / Drive upload.
  exportingAnnots = true;
  renderAnnots();
  const out = document.createElement("canvas");
  out.width = seg.canvas.width;
  out.height = seg.canvas.height;
  const c = out.getContext("2d");
  c.drawImage(seg.canvas, 0, 0);
  c.drawImage(annotCanvas, 0, 0);
  exportingAnnots = false;
  renderAnnots();
  return out;
}

/* ------------------------- Recent captures (last 3, IndexedDB) ------------------------- */
// A closed result tab used to mean a lost capture (the background job expires in
// 5 minutes). Every finished single-image capture is kept locally as a JPEG so the
// last few can be reopened from the popup or the toolbar. Only 3 are kept: full-page
// screenshots are big, and Drive is the real archive.
const FPC_DB = "fpc-captures", FPC_STORE = "captures", RECENT_KEEP = 3;

function dbUpgrade(req) {
  const db = req.result;
  if (!db.objectStoreNames.contains(FPC_STORE)) db.createObjectStore(FPC_STORE, { keyPath: "id" });
}
function dbOpen() {
  return new Promise((res, rej) => {
    // No explicit version: open whatever exists (and create it at v1 if it does not).
    // Pinning a version here would throw VersionError once a heal has bumped it.
    const r = indexedDB.open(FPC_DB);
    r.onupgradeneeded = () => dbUpgrade(r);
    r.onsuccess = () => {
      const db = r.result;
      if (db.objectStoreNames.contains(FPC_STORE)) return res(db);
      // The database exists at this version but has no store - e.g. a deleteDatabase
      // that was blocked and half-applied. Without this it would stay silently broken
      // forever, so bump the version to get an upgrade event and create the store.
      const next = db.version + 1;
      db.close();
      const r2 = indexedDB.open(FPC_DB, next);
      r2.onupgradeneeded = () => dbUpgrade(r2);
      r2.onsuccess = () => res(r2.result);
      r2.onerror = () => rej(r2.error);
    };
    r.onerror = () => rej(r.error);
  });
}
function dbRun(db, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(FPC_STORE, mode);
    const req = fn(tx.objectStore(FPC_STORE));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
async function recentList() {
  const db = await dbOpen();
  const all = (await dbRun(db, "readonly", (st) => st.getAll())) || [];
  return all.sort((a, b) => b.ts - a.ts);
}
async function recentGet(id) { const db = await dbOpen(); return dbRun(db, "readonly", (st) => st.get(id)); }
async function recentDelete(id) { const db = await dbOpen(); await dbRun(db, "readwrite", (st) => { st.delete(id); }); }
// Annotations are stored WITHOUT the info bar's offset, so a capture saved with the
// bar on and reopened with it off (or vice versa) still lines up.
function annotsForSave() {
  if (doc) return cloneAnnots(annotations);
  const dy = (infoBar && !stampLocked) ? -infoBarHeight() : 0;
  const list = cloneAnnots(annotations);
  if (dy) shiftAnnotList(list, dy);
  return list;
}
// Every Recent write goes through ONE queue, and each is a read-modify-write inside ONE
// readwrite transaction. The old read-then-write in two transactions could put an older row
// shape back with newer marks once whole-row writes exist.
let recentChain = Promise.resolve();
function recentQueue(fn) { const p = recentChain.then(fn).catch(() => {}); recentChain = p; return p; }
// Raw read-modify-write. Call it only from INSIDE a queue link.
const recentAlias = new Map();   // provisional row id -> the reload's real row (see saveRecent)
async function rowTx(id, mutate) {
  id = recentAlias.get(id) || id;
  const db = await dbOpen();
  await dbRun(db, "readwrite", (st) => {
    const g = st.get(id);
    g.onsuccess = () => { const rec = g.result; if (!rec) return; if (mutate(rec) !== false) st.put(rec); };
    return g;
  });
}
// Queued. NEVER await this from inside a recentQueue callback: it would wait for itself.
function recentPatch(id, mutate) { return recentQueue(() => rowTx(id, mutate)); }
async function recentUpdateAnnots(id, annots) { return recentPatch(id, (rec) => { rec.annots = annots; }); }
// A single row turned into the joined image IN PLACE: same id, no new slot, nothing pruned (D3).
// j = { now, hostPid, title, w, h, thumb, blob, annots, rects, layout, pages:[{pid, jpeg?, ...}] }
function rowAsJoined(rec, j) {
  const old = rec.kind === "joined" ? rec.pages
    : [{ pid: j.hostPid, jpeg: rec.blob, thumb: rec.thumb, w: rec.w, h: rec.h, title: rec.title,
         url: rec.url, env: rec.env, dpr: rec.dpr, stampTs: rec.ts }];
  const upgrading = rec.kind !== "joined";
  rec.pages = j.pages.map((p) => { const o = old.find((q) => q.pid === p.pid) || {}; return Object.assign({}, o, p, { jpeg: p.jpeg || o.jpeg }); });
  if (rec.pages.some((p) => !p.jpeg)) return false;          // never write a row it cannot reopen
  if (upgrading) { rec.hostTs = rec.ts; rec.ts = Math.max(rec.ts, j.now); }   // newest once, at the join only
  rec.kind = "joined"; rec.hostPid = j.hostPid;
  rec.title = j.title; rec.w = j.w; rec.h = j.h; rec.thumb = j.thumb; rec.blob = j.blob;
  rec.annots = j.annots; rec.rects = j.rects; rec.layout = j.layout;
}
// Back to a single capture (Undo join, or Ctrl+Z of a join): the host page's own JPEG, thumb
// and capture time come back out of pages[] - no re-encode.
function rowAsSingle(rec, pid, annots) {
  if (rec.kind === "joined") {
    const p = (rec.pages || []).find((q) => q.pid === pid);
    if (!p || !p.jpeg) return false;
    rec.blob = p.jpeg; rec.thumb = p.thumb; rec.w = p.w; rec.h = p.h; rec.title = p.title;
    rec.url = p.url; rec.env = p.env; rec.dpr = p.dpr; rec.ts = rec.hostTs || rec.ts;
    for (const k of ["kind", "pages", "layout", "rects", "hostPid", "hostTs"]) delete rec[k];
  }
  rec.annots = annots;
}
// There is no "I am done annotating" moment, so save shortly after every change
// instead. Dragging fires constantly, hence the debounce; the tab going away
// flushes immediately so at most a moment's work can ever be lost.
function scheduleRecentSave() {
  if (!recentEnabled || !currentRecentId) return;
  if (recentSaveTimer) clearTimeout(recentSaveTimer);
  recentSaveTimer = setTimeout(flushRecentSave, 1500);
}
function flushRecentSave() {
  if (recentSaveTimer) { clearTimeout(recentSaveTimer); recentSaveTimer = null; }
  if (!currentRecentId) return;
  const id = currentRecentId;
  if (docDirty) { docDirty = false; return recentWriteDoc(id); }
  try { recentUpdateAnnots(id, annotsForSave()).catch(() => {}); } catch (_) {}
}
function recentWriteDoc(id) {
  if (doc) return recentWriteJoined(id);
  const annots = annotsForSave(), pid = hostPid;             // snapshot NOW, write later
  return recentPatch(id, (rec) => rowAsSingle(rec, pid, annots));
}
function makeThumb(src) {
  const tw = 220, th = Math.min(400, Math.max(1, Math.round(src.height * tw / src.width)));
  const tc = document.createElement("canvas"); tc.width = tw; tc.height = th;
  tc.getContext("2d").drawImage(src, 0, 0, src.width, src.width * th / tw, 0, 0, tw, th);
  return tc.toDataURL("image/jpeg", 0.7);
}
// One JPEG per page image, cached by the image itself: parts are rebuilt on every change (a
// Swap makes new part objects) but share their src, so pages are encoded once.
const partJpegCache = new WeakMap();
const isBlob = (x) => typeof Blob !== "undefined" && x instanceof Blob;
async function partJpeg(p) {
  if (!p || !p.src) throw new Error("no page image");
  if (partJpegCache.has(p.src)) return partJpegCache.get(p.src);
  let jpeg;
  if (isBlob(p.src) && /jpe?g/i.test(p.src.type || "")) jpeg = p.src;             // reopened from Recent: already one
  else jpeg = await canvasToBlob(isBlob(p.src) ? await blobToCanvas(p.src) : p.src, "image/jpeg", 0.85);
  partJpegCache.set(p.src, jpeg);
  return jpeg;
}
// Snapshot NOW (the picture can change again before the encode finishes), write in the queue.
// Called only from inside the queue's own link, so it uses rowTx - never recentPatch, which
// would wait for itself.
function recentWriteJoined(id) {
  const d = doc, c = segments[0].canvas;
  const snap = {
    now: Date.now(), hostPid: d.hostPid, title: meta && meta.title, w: c.width, h: c.height,
    thumb: makeThumb(c), annots: annotsForSave(), rects: pageRects(),
    layout: { dir: d.dir, matchHeights: d.matchHeights, matchText: d.matchText, cuts: d.cuts, floor: d.floor,
              dpr: d.dpr, order: d.parts.map((p) => p.pid) },
    pages: d.parts.map((p) => ({ pid: p.pid, title: p.meta && p.meta.title, url: p.meta && p.meta.url,
      env: p.meta && p.meta.env, dpr: p.dpr, w: p.w, h: p.h, stampTs: p.stampTime ? +new Date(p.stampTime) : null,
      barOn: !!p.barOn, barBaked: !!p.barBaked, label: p.label, origin: p.origin, wasCropped: !!p.wasCropped, capKey: p.capKey || null }))
  };
  const parts = d.parts;
  return recentQueue(async () => {
    try {
      snap.blob = await canvasToBlob(c, "image/jpeg", 0.85);
      for (const pg of snap.pages) {
        const p = parts.find((q) => q.pid === pg.pid);
        // The host's own capture is already the row's JPEG (a crop detaches the row, so an
        // attached host's pixels are the ones saveRecent encoded): keep it, never re-encode.
        if (pg.pid === d.hostPid && p && !isBlob(p.src) && !p.barBaked && !p.wasCropped) continue;
        pg.jpeg = await partJpeg(p);
      }
      await rowTx(id, (rec) => rowAsJoined(rec, snap));
    } catch (_) {
      if (currentRecentId === id) currentRecentId = null;   // never keep writing marks to a row out of step
    }
  });
}

async function recentPut(rec) {
  const db = await dbOpen();
  await dbRun(db, "readwrite", (st) => { st.put(rec); });
  const extra = (await recentList()).slice(RECENT_KEEP);
  if (extra.length) await dbRun(db, "readwrite", (st) => { extra.forEach((r) => st.delete(r.id)); });
}

function saveRecent() {
  try {
    if (!recentEnabled) return;                                      // nothing is kept unless the user opted in
    if (doc || !baseSeg0 || segments.length !== 1 || captureTime) return;   // joined rows: Recent slice   // single-image captures only; never re-save a restored one
    if (currentRecentId) return;                // already has (or is getting) a row
    const checkJob = !!jobId && !recentJobChecked;
    recentJobChecked = true;
    const src = baseSeg0;
    const tw = 220, th = Math.min(400, Math.max(1, Math.round(src.height * tw / src.width)));
    const tc = document.createElement("canvas"); tc.width = tw; tc.height = th;
    tc.getContext("2d").drawImage(src, 0, 0, src.width, src.width * th / tw, 0, 0, tw, th);
    const thumb = tc.toDataURL("image/jpeg", 0.7);
    const m = meta || {};
    const id = Date.now();
    currentRecentId = id;                       // later annotation edits update THIS row
    // The id is set above, synchronously, and this link is the FIRST in the Recent queue: an
    // edit flushed during the encode, or a join clicked right after the capture, queues behind
    // the row instead of finding none.
    // Encoding starts NOW, in parallel with the job check: a join right after the capture
    // waits for this row, so it should be ready as soon as possible. (On a reload that
    // re-attaches, the encode is simply unused.)
    const encoded = new Promise((res) => src.toBlob(res, "image/jpeg", 0.85));
    recentQueue(async () => {
      if (checkJob) {
        // A reloaded editor re-streams the SAME job. Re-use its row (and bring its marks back)
        // instead of adding a duplicate that pushes an older capture out of Recent. A
        // duplicated tab is not a reload: it gets its own row.
        const all = await recentList().catch(() => []);
        const prior = all.find((r) => r.job === jobId);
        if (prior && !rowHeldElsewhere(prior.id) && prior.kind === "joined") {
          // A joined picture: reopen it whole. Detach FIRST - attached, restoreRecent's opening
          // flush would write this fresh, empty mark list over the joined row's marks.
          if (currentRecentId === id) { currentRecentId = null; setTimeout(() => restoreRecent(prior.id, { reload: true }), 0); }
          return;
        }
        if (prior && !rowHeldElsewhere(prior.id)) {
          recentAlias.set(id, prior.id);         // writes queued against `id` land on the real row
          if (currentRecentId === id) reattachRecent(prior);
          return;
        }
      }
      const blob = await encoded;
      if (!blob) return;
      return recentPut({ id, ts: id, job: jobId || null, title: m.title || "", url: m.url || "", dpr, w: src.width, h: src.height, env: m.env || null, thumb, blob, annots: [] });
    });
  } catch (_) {}
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ts).toLocaleString();
}

async function openRecent() {
  const d = el("recentDrawer"), list = el("recentList");
  let items = [];
  if (recentEnabled) { try { items = await recentList(); } catch (_) {} }
  list.innerHTML = "";
  const count = el("recentCount");
  if (count) count.textContent = recentEnabled && items.length ? items.length + " of 3 kept" : "";
  if (!recentEnabled) {
    const e = document.createElement("div"); e.className = "recent-empty";
    e.textContent = "Keeping recent captures is turned off. Switch on \u201cKeep recent captures\u201d in Settings and your next 3 captures will be kept here.";
    list.appendChild(e);
  } else if (!items.length) {
    const e = document.createElement("div"); e.className = "recent-empty";
    e.textContent = "No saved captures yet. Your last 3 captures are kept here automatically, so closing this tab by mistake is not a lost capture.";
    list.appendChild(e);
  }
  for (const r of items) {
    const it = document.createElement("div"); it.className = "recent-item";
    it.title = "Reopen this capture";
    it.tabIndex = 0;                       // reachable with Tab, activate with Enter/Space
    const img = document.createElement("img"); img.src = r.thumb; img.alt = "";
    const tx = document.createElement("div"); tx.className = "recent-txt";
    const t = document.createElement("b"); t.textContent = r.title || r.url || "(untitled)";
    const n = (r.annots || []).length;
    const s = document.createElement("span");
    const pages = (r.kind === "joined" && r.pages) ? "  \u00b7  " + r.pages.length + " pages" : "";
    s.textContent = timeAgo(r.ts) + "  \u00b7  " + r.w + "\u00d7" + r.h + " px" + pages + (n ? "  \u00b7  " + n + " annotation" + (n > 1 ? "s" : "") : "");
    tx.appendChild(t); tx.appendChild(s);
    const open = document.createElement("span"); open.className = "recent-open"; open.textContent = "Reopen";
    const del = document.createElement("button"); del.className = "recent-del"; del.title = "Remove from Recent"; del.textContent = "\u00d7";
    del.addEventListener("click", async (ev) => { ev.stopPropagation(); try { await recentDelete(r.id); } catch (_) {} openRecent(); });
    it.appendChild(img); it.appendChild(tx); it.appendChild(open); it.appendChild(del);
    it.addEventListener("click", () => restoreRecent(r.id));
    it.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); restoreRecent(r.id); }
    });
    list.appendChild(it);
  }
  d.hidden = false;
  el("recentBtn").classList.add("on");
  const first = list.querySelector(".recent-item");
  if (first) first.focus();
}
function closeRecent() { const d = el("recentDrawer"); if (d) d.hidden = true; el("recentBtn").classList.remove("on"); }
function toggleRecent() { el("recentDrawer").hidden ? openRecent() : closeRecent(); }

async function restoreRecent(id, opts) {
  if (docBusy) { toast("One moment - still putting the picture back"); return; }
  if (jobId && !captureSettled) { toast("Wait for the current capture to finish, then reopen a recent one"); return; }
  let rec = null;
  try { rec = await recentGet(id); } catch (_) {}
  if (!rec) { toast("That capture is no longer available"); return; }
  if ((annotations.length || doc) && !confirm("Replace the current image? Annotations on it will be lost.")) return;
  flushRecentSave();          // the row being left keeps up to 1.5 s of pending edits
  if (rec.kind === "joined" && rec.pages && rec.pages.length > 1) return restoreJoinedRecent(rec, opts);
  let bmp;
  try { bmp = await createImageBitmap(rec.blob); } catch (_) { toast("Couldn't load that capture"); return; }

  // Reset the editor to a fresh single-image state.
  if (annotating) exitAnnot();
  try { endCrop(); } catch (_) {}
  for (const s of segments) s.canvas.remove();
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; annotCtx = null; }
  annotations = []; undoStack = []; redoStack = []; liveAnnot = null; drag = null; clearActiveAnnot(); clearPendingSel();
  doc = null; docLayout = null; docLinks = [];   // else applyInfoBar() bails and the reopened capture has no bar

  const canvas = document.createElement("canvas");
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  canvasHost.insertBefore(canvas, cropOverlay);
  segments = [{ canvas, ctx, startY: 0, height: canvas.height }];
  fullWpx = canvas.width; fullHpx = canvas.height; truncated = false;
  meta = { mode: "visible", title: rec.title, url: rec.url, dpr: rec.dpr || 1, env: rec.env || undefined };
  dpr = rec.dpr || 1;
  captureTime = new Date(rec.ts);
  stampTime = captureTime;
  baseSeg0 = canvas; stampLocked = false; infoBarLink = null; aborted = false;
  wasCropped = false;
  lastDriveLink = null;
  { const cl = el("copyLink"); if (cl) { cl.hidden = true; const s = cl.querySelector("span"); if (s) s.textContent = "Copy link"; } }

  progressWrap.hidden = true; errorWrap.hidden = true; stage.hidden = false; tools.hidden = false;
  setTimeout(maybeAnnot, 0);   // after this path has finished rebuilding segments
  applyInfoBar();
  el("crop").disabled = false;
  // Bring the saved markup back as real, editable annotations (stored bar-less, so
  // shift them down if the info bar is showing now).
  currentRecentId = rec.id;                   // further edits keep updating this row
  hostPid = "r" + rec.id; docDirty = false;
  noteRestored(rec, opts);
  if (rec.annots && rec.annots.length) {
    annotations = cloneAnnots(rec.annots);
    if (infoBar) shiftAnnotList(annotations, infoBarHeight());
    setupAnnotationLayer();
    renderAnnots();
  }
  reflectInfoBarBtn(); updateDims(); applyZoom();
  closeRecent();
  bakedMarks = false; exportedClean = true; syncProtection();   // its marks are already in Recent
  const n = (rec.annots || []).length;
  toast("Reopened: " + (rec.title || "capture") + (n ? "  (" + n + " annotation" + (n > 1 ? "s" : "") + ")" : ""));
}

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
    shareAnyone: !!cfg.driveShareAnyone
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

async function driveExportBlob() {
  // One canvas → PNG (with bar + annotations baked in); multi-part → multi-page PDF.
  if (segments.length === 1) {
    return { blob: await canvasToBlob(flatten(segments[0]), "image/png"), ext: "png", mime: "image/png" };
  }
  const bytes = FPCPDF.build(await buildPdfImages());
  return { blob: new Blob([bytes], { type: "application/pdf" }), ext: "pdf", mime: "application/pdf" };
}

function driveFilename(ext) {
  // Always add a HHMMSS stamp so repeated uploads don't collide in Drive.
  const d = new Date();
  const stamp = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const base = buildFilename(ext).replace(new RegExp("\\." + ext + "$"), "");
  return `${base}-${stamp}.${ext}`;
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

function notifyDrive(title, message) {
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create("fpc-drive", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: title,
        message: message,
        priority: 2
      });
    }
  } catch (_) {}
}

// Re-copy the last uploaded Drive link. Recovery for when the auto-copy on upload
// failed (tab not focused) or the clipboard was later overwritten by a Copy / Ctrl+C
// (which puts the image on the clipboard, replacing the link).
async function copyDriveLink() {
  if (!lastDriveLink) return;
  const btn = el("copyLink");
  const label = btn && btn.querySelector("span");
  try {
    await navigator.clipboard.writeText(lastDriveLink);
    toast("Drive link copied");
    if (label) {
      const orig = label.textContent;
      label.textContent = "✓ Copied";
      setTimeout(() => { if (label.textContent === "✓ Copied") label.textContent = orig; }, 2000);
    }
  } catch (_) {
    toast("Couldn't copy — click anywhere on this page first, then try again");
  }
}

async function uploadToDrive() {
  const btn = el("drive");
  const label = btn.querySelector("span");
  const orig = label ? label.textContent : "";
  let ok = false;
  try {
    const { folderId, shareAnyone } = await getDriveSettings();
    // Acquire the token first — surfaces NO_CLIENT / cancel before the expensive encode.
    // getDriveToken() refreshes silently when possible, so no repeated account picker.
    let token = await getDriveToken();
    btn.disabled = true;
    if (label) label.textContent = "Uploading…";
    const { blob, ext, mime } = await driveExportBlob();
    const filename = driveFilename(ext);

    let res = await drivePost(token, filename, folderId, blob, mime);
    if (res.status === 401) { // token went stale — refresh once
      await chrome.storage.session.remove("driveToken").catch(() => {});
      token = await getDriveToken();
      res = await drivePost(token, filename, folderId, blob, mime);
    }
    let rootFallback = false;
    if ((res.status === 404 || res.status === 403) && folderId) {
      // Folder not writable (wrong id / no access) → upload to Drive root instead.
      res = await drivePost(token, filename, "", blob, mime);
      rootFallback = res.ok;
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 120));
    const file = await res.json();

    // Optionally widen sharing to anyone-with-the-link (off by default for privacy).
    let sharedPublic = false;
    if (shareAnyone) {
      try {
        const pr = await fetch("https://www.googleapis.com/drive/v3/files/" + file.id + "/permissions", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ role: "reader", type: "anyone" })
        });
        sharedPublic = pr.ok;
      } catch (_) {}
    }

    const link = file.webViewLink || ("https://drive.google.com/file/d/" + file.id + "/view");
    let copied = false;
    try { await navigator.clipboard.writeText(link); copied = true; } catch (_) {}

    const vis = shareAnyone ? (sharedPublic ? "public link" : "private — sharing failed") : "private";
    lastDriveLink = link;
    sentToDrive = true; rosterChanged(true);
    // Reveal the "Copy link" button so the link can be re-copied at any time — even if
    // the auto-copy below fails (tab not focused) or the clipboard later gets overwritten
    // by a Ctrl+C / Copy (which puts the image on the clipboard, replacing this link).
    const clBtn = el("copyLink"); if (clBtn) clBtn.hidden = false;
    ok = true;
    markExported();
    toast("Uploaded ✓ (" + vis + ")" + (rootFallback ? ", to root" : "") +
      (copied ? " — link copied" : " — copy the link manually"));
    notifyDrive("Uploaded to Google Drive ✓",
      (copied ? "Link copied to clipboard — paste it anywhere." : "Uploaded — copy the link manually.") +
      " (" + vis + (rootFallback ? ", root" : "") + ")  ·  click to open");
  } catch (e) {
    const m = (e && e.message) || String(e);
    let msg;
    if (m === "NO_CLIENT") msg = "First set up Google Drive in Settings ⚙";
    else if (/CANCELLED/.test(m)) msg = "Drive sign-in cancelled";
    else if (/too large/.test(m)) msg = "Image too large to upload";
    else msg = "Drive upload failed: " + m.slice(0, 90);
    toast(msg);
    if (!/CANCELLED|NO_CLIENT/.test(m)) notifyDrive("Drive upload failed", msg);
  } finally {
    btn.disabled = false;
    if (label) {
      if (ok) { label.textContent = "✓ Link copied"; setTimeout(() => { if (label.textContent === "✓ Link copied") label.textContent = orig; }, 2800); }
      else label.textContent = orig;
    }
  }
}

/* ------------------------- Work protection ------------------------- */
// One rule for every editor. Work is "unsaved" until a Download, Copy or Drive send has
// carried it out; any later edit makes it unsaved again. Print does not count: the print
// dialog gives no way to tell Print from Cancel.
//   - closing or reloading the tab asks "Leave site?" only when that work includes marks
//     (live, or baked into the pixels by a Crop) - a plain capture never nags;
//   - an unexported capture, marked or not, is not auto-discardable, so Memory Saver
//     cannot drop it while the tester reproduces the bug. Exporting hands it back.
function learnMyTab() {
  try {
    chrome.tabs.getCurrent().then((t) => { myTabId = t ? t.id : null; myWindowId = t ? t.windowId : null; syncProtection(); rosterChanged(true); }, () => {});
  } catch (_) {}
}
function markEdited() { exportedClean = false; syncProtection(); noteEdit(); }
function markExported() { exportedClean = true; syncProtection(); }
function openTextDraft() {
  const i = document.querySelector(".annot-text-input");
  return !!(i && String(i.value || "").trim());
}
function hasUnsavedMarks() {
  if (!captureSettled || aborted) return false;
  if (openTextDraft()) return true;    // typing is an edit no pushHistory has seen yet
  if (exportedClean) return false;
  return annotations.length > 0 || bakedMarks;
}
function needsDiscardGuard() { return captureSettled && !aborted && segments.length > 0 && !exportedClean; }
function syncProtection() {
  const want = needsDiscardGuard();
  if (myTabId == null || want === discardGuardOn) return;
  discardGuardOn = want;
  // tabId is required: without it tabs.update targets the ACTIVE tab, not this one.
  try { chrome.tabs.update(myTabId, { autoDiscardable: !want }).catch(() => {}); } catch (_) {}
}
function onBeforeUnload(e) {
  if (!hasUnsavedMarks()) return;
  e.preventDefault();
  e.returnValue = true;      // legacy path; Chrome 119+ honours preventDefault alone
}

// A reloaded editor (F5, a tab the browser discarded, a restored session) usually finds
// its job gone: the background keeps a capture only while its worker lives. With Recent
// on, reopen this job's own saved copy; otherwise say plainly what happened.
async function onExpired() {
  if (recentEnabled) {
    let prior = null;
    try { prior = (await recentList()).find((r) => jobId && r.job === jobId); } catch (_) {}
    if (prior) {
      const shared = rowHeldElsewhere(prior.id);
      settleCapture();
      await restoreRecent(prior.id);
      if (currentRecentId === prior.id) {
        if (shared) currentRecentId = null;   // another open tab owns this row: show it, never write to it
        toast("This tab was reloaded - reopened its saved copy from Recent");
        return;
      }
    }
  }
  const why = document.wasDiscarded
    ? "The browser closed this tab to save memory, and a capture lives only in its tab."
    : "This tab was reloaded, and a capture lives only in its tab.";
  showError(why + " Capture the page again." +
    (recentEnabled ? " Captures you kept are under Recent." : ""), "This capture is no longer here");
}
// Is this Recent row the live document of another open editor (a duplicated tab)?
function rowHeldElsewhere(id) {
  try {
    return chrome.extension.getViews({ type: "tab" }).some((v) => v !== window &&
      typeof v.fpcEditorState === "function" && v.fpcEditorState().recentId === id);
  } catch (_) { return false; }
}
// A joined Recent row comes back AS a joined picture: live pages, editable marks, Undo join.
async function restoreJoinedRecent(rec, opts) {
  const L = rec.layout || {};
  const order = L.order || rec.pages.map((p) => p.pid);
  const parts = order.map((pid) => rec.pages.find((p) => p.pid === pid)).filter(Boolean).map((pg) => ({
    pid: pg.pid, src: pg.jpeg, w: pg.w, h: pg.h, dpr: pg.dpr || 1, origin: pg.origin || "recent",
    meta: { title: pg.title, url: pg.url, env: pg.env }, stampTime: pg.stampTs ? new Date(pg.stampTs) : null,
    barOn: !!pg.barOn, barBaked: !!pg.barBaked, label: pg.label, wasCropped: !!pg.wasCropped,
    capKey: pg.capKey || null
  }));
  const hd = L.dpr || rec.dpr || 1;
  const d = { kind: "joined", dpr: hd, dir: L.dir || "row", matchHeights: L.matchHeights == null ? null : L.matchHeights,
              matchText: !!L.matchText, cuts: L.cuts || null, floor: L.floor || {}, parts, hostPid: rec.hostPid,
              meta: { mode: "joined", title: rec.title, url: rec.url, env: rec.env, dpr: hd } };
  // Reset to a blank editor with one placeholder canvas for the composite to replace.
  if (annotating) exitAnnot();
  try { endCrop(); } catch (_) {}
  for (const sg of segments) sg.canvas.remove();
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; annotCtx = null; }
  annotations = []; undoStack = []; redoStack = []; liveAnnot = null; drag = null; clearActiveAnnot(); clearPendingSel();
  doc = null; docLayout = null; docLinks = [];
  const ph = document.createElement("canvas"); ph.width = 1; ph.height = 1;
  canvasHost.insertBefore(ph, cropOverlay);
  segments = [{ canvas: ph, ctx: ph.getContext("2d"), startY: 0, height: 1 }];
  dpr = hd; truncated = false; aborted = false; lastDriveLink = null;
  { const cl = el("copyLink"); if (cl) { cl.hidden = true; const s2 = cl.querySelector("span"); if (s2) s2.textContent = "Copy link"; } }
  progressWrap.hidden = true; errorWrap.hidden = true; stage.hidden = false; tools.hidden = false;
  let res;
  try { res = await applyDoc(d, {}); } catch (e) { res = { ok: false, reason: e && e.message }; }
  if (!res || !res.ok) return restoreJoinedFlat(rec);
  const saved = cloneAnnots(rec.annots || []);
  annotations = rec.rects ? remapAnnots(saved, rec.rects, pageRects()) : saved;
  currentRecentId = rec.id; docDirty = false;
  noteRestored(rec, opts);
  captureTime = new Date(rec.ts);          // a restored capture: saveRecent and the join offer skip it
  stampTime = captureTime; lastJoinEntry = null;
  el("crop").disabled = false;
  if (!annotCanvas) setupAnnotationLayer();
  renderAnnots(); setTimeout(maybeAnnot, 0);
  reflectInfoBarBtn(); updateDims(); applyZoom();
  closeRecent();
  bakedMarks = false; exportedClean = true; syncProtection();
  toast("Reopened: " + (rec.title || "capture") + "  (" + parts.length + " pages)");
}
// The pages could not be rebuilt: show the flat copy, marks in place, and DETACH - the joined row
// must never be overwritten with a flat picture.
async function restoreJoinedFlat(rec) {
  let canvas;
  try { canvas = await blobToCanvas(rec.blob); } catch (_) { toast("Couldn't load that capture"); return; }
  for (const sg of segments) sg.canvas.remove();
  doc = null; docLayout = null; docLinks = [];
  canvasHost.insertBefore(canvas, cropOverlay);
  segments = [{ canvas, ctx: canvas.getContext("2d"), startY: 0, height: canvas.height }];
  fullWpx = canvas.width; fullHpx = canvas.height; truncated = false;
  meta = { mode: "visible", title: rec.title, url: rec.url, dpr: rec.dpr || 1, env: rec.env || undefined };
  dpr = rec.dpr || 1; captureTime = new Date(rec.ts); stampTime = captureTime;
  baseSeg0 = canvas; stampLocked = true; infoBarLink = null; wasCropped = false;
  hostPid = "r" + rec.id + "f"; currentRecentId = null; docDirty = false;
  annotations = cloneAnnots(rec.annots || []);
  setupAnnotationLayer(); renderAnnots(); setTimeout(maybeAnnot, 0);
  el("crop").disabled = false;
  reflectInfoBarBtn(); updateDims(); applyZoom();
  closeRecent();
  bakedMarks = false; exportedClean = true; syncProtection();
  toast("Reopened as one picture - its pages couldn't be rebuilt");
}

function reattachRecent(prior) {
  currentRecentId = prior.id;
  const n = (prior.annots || []).length;
  if (!n || annotations.length) return;
  annotations = cloneAnnots(prior.annots);
  if (infoBar) shiftAnnotList(annotations, infoBarHeight());
  if (!annotCanvas) setupAnnotationLayer();
  renderAnnots();
  exportedClean = true;      // they came from storage, nothing new to lose yet
  syncProtection();
  toast("This tab was reloaded - brought back " + n + " mark" + (n > 1 ? "s" : "") + " from Recent");
}

// Read by the popup (chrome.extension.getViews) before "Update now" reloads the extension,
// which closes every editor tab. Top-level function declarations are window properties.
function fpcEditorState() {
  return {
    title: (meta && meta.title) || "",
    capturing: !!jobId && !captureSettled,
    failed: aborted,
    hasImage: segments.length > 0,
    marks: annotations.length + (openTextDraft() ? 1 : 0),
    unsavedMarks: hasUnsavedMarks(),
    unexported: needsDiscardGuard(),
    inRecent: !!currentRecentId,
    recentId: currentRecentId,
    tabId: myTabId
  };
}
// Commit a half-typed label and write marks to Recent before the extension reloads.
// Returns a promise so the popup can wait for the IndexedDB write to land.
function fpcBeforeReload() {
  try { const a = document.activeElement; if (a && a.classList && a.classList.contains("annot-text-input")) a.blur(); } catch (_) {}
  if (recentSaveTimer) { clearTimeout(recentSaveTimer); recentSaveTimer = null; }
  if (!currentRecentId) return Promise.resolve();
  try { return recentUpdateAnnots(currentRecentId, annotsForSave()).catch(() => {}); } catch (_) { return Promise.resolve(); }
}

/* ------------------------- UI bits ------------------------- */
function showError(message, title) {
  aborted = true; // stop any further tile drawing / finalize from racing over the error
  { const t = document.querySelector(".error-title"); if (t) t.textContent = title || "Couldn\u2019t capture this page"; }
  settleCapture();
  progressWrap.hidden = true;
  stage.hidden = true;
  tools.hidden = true;
  errorWrap.hidden = false;
  errorMsg.textContent = message || "Something went wrong.";
  rosterChanged(true);
}

let toastTimer = null;
let stMsgTimer = null;
function toast(text) {
  // The pill is transient; the status bar keeps the last message
  // around long enough to read it after the pill has gone.
  const sm = el("stMsg");
  if (sm) {
    sm.textContent = text;
    clearTimeout(stMsgTimer);
    stMsgTimer = setTimeout(() => { sm.textContent = ""; }, 8000);
  }
  const t = el("toast");
  t.textContent = text;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => (t.hidden = true), 250);
  }, 2200);
}

/* ------------------------- Editor roster (cross-tab) -------------------------
 * Every open editor tab joins one same-origin BroadcastChannel, so a capture can be joined with
 * the page captured in ANOTHER tab in one click. Nothing here needs a permission:
 * BroadcastChannel is a plain web API; chrome.tabs.getCurrent / get / update / onRemoved and
 * chrome.windows.update need none; storage is already declared.
 *
 * Messages (all carry v + from; `to` = addressed to one editor, everyone else drops it before
 * touching the payload - a 'part' Blob reaches EVERY open editor):
 *   who   {reqId}                     roll-call; every editor that has something answers 'here'
 *   here  {card}                      a card, unsolicited on every change or as a roll-call answer
 *   thumbReq {to} / thumb {to, capKey, rev, url}   thumbnails only for cards actually on screen
 *                                     (all extension tabs share ONE renderer thread)
 *   give  {to, reqId, capKey, at}     host asks one source for its page(s)
 *   giving{to, reqId}                 source ack, sent BEFORE the PNG encode
 *   part  {to, reqId, pages:[...]}    the hand-off (PNG Blob + meta + page-local marks)
 *   giveFail {to, reqId, reason}
 *   bye   {}                          pagehide
 * Which pages a joined picture holds is state (card.pages), not an event: the source tab's
 * "Joined into…" band follows it, so Undo join, a closed host or a Ctrl+Z need no message.
 */
const ROSTER_NAME = "fpc-editors", ROSTER_V = 1;
const JOIN_WINDOW_MS = 20 * 60 * 1000;
const ROLLCALL_MS = 400;
const GIVE_ACK_MS = 2000;
const GIVE_PART_MS = 15000;
const GIVE_STALE_MS = 30000;
const MIRROR_PREFIX = "fpcEd:", DISMISS_PREFIX = "fpcDis:";

const editorId = rosterNewId();
let rosterBc = null, myWindowId = null;
let lastActive = Date.now(), editRev = 0, pixRev = 0;
let sentToDrive = false;
let restoredRecentId = null;     // this editor shows a capture reopened from Recent (not a reload)
const peers = new Map();         // editorId -> card (+ seenAt)
const pendingGives = new Map();  // reqId -> { reqId, peer, resolve, reject, timer, acked, onAck }
let hereTimer = null;
const handoffPngCache = new WeakMap();   // page canvas -> its PNG Blob (a canvas's pixels never change in place)
let thumbCache = null;           // { key, url }
const rosterListeners = new Set();   // UI hooks (badge, suggestion bar, source band)
let rosterStarted = false;

function rosterNewId() {
  try { return crypto.randomUUID(); } catch (_) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}
function myCapKey() {
  if (restoredRecentId != null) return "recent:" + restoredRecentId;
  return jobId ? "job:" + jobId : null;
}
// The capture keys of the pages this editor shows: its own, plus every page joined into it.
function myPages() {
  if (doc) return doc.parts.map((p) => ({ k: p.pid === doc.hostPid ? myCapKey() : (p.capKey || null), title: p.label || pageLabel(p) }));
  return [{ k: myCapKey(), title: (meta && meta.title) || "" }];
}
function myState() {
  if (aborted) return "gone";
  if (!captureSettled) return "capturing";
  if (!meta || !segments.length || stage.hidden) return "empty";
  return segments.length === 1 ? "ready" : "parts";
}
function pageKeyOf(url) {
  try { const u = new URL(url); return u.origin + u.pathname + String(u.hash || "").split("?")[0]; }
  catch (_) { return String(url || ""); }
}
function rosterThumb() {
  // Never flatten() here: that allocates a full-size canvas (1912x16000 = 122 MB).
  const src = segments[0] && segments[0].canvas;
  if (!src) return "";
  const key = editRev + ":" + pixRev + ":" + src.width + "x" + src.height;
  if (thumbCache && thumbCache.key === key) return thumbCache.url;
  const tw = 220, th = Math.min(400, Math.max(1, Math.round(src.height * tw / src.width)));
  const sh = Math.min(src.height, src.width * th / tw);
  const tc = document.createElement("canvas"); tc.width = tw; tc.height = th;
  const g = tc.getContext("2d");
  g.drawImage(src, 0, 0, src.width, sh, 0, 0, tw, th);
  if (annotCanvas && annotations.length) {
    exportingAnnots = true; renderAnnots();
    g.drawImage(annotCanvas, 0, 0, src.width, sh, 0, 0, tw, th);
    exportingAnnots = false; renderAnnots();
  }
  thumbCache = { key, url: tc.toDataURL("image/jpeg", 0.7) };
  return thumbCache.url;
}
function myCard(withThumb) {
  const st = myState();
  const pages = myPages();
  const own = pages.find((p) => p.k === myCapKey());
  const c = {
    editorId, capKey: myCapKey(), tabId: myTabId, windowId: myWindowId, state: st,
    title: (meta && meta.title) || "", ownTitle: (own && own.title) || (meta && meta.title) || "",
    url: (meta && meta.url) || "", pageKey: pageKeyOf(meta && meta.url),
    stampTime: stampTime ? new Date(stampTime).getTime() : (captureTime ? new Date(captureTime).getTime() : null),
    lastActive, rev: editRev, pixRev,
    marks: annotations.length, w: segments[0] ? segments[0].canvas.width : 0,
    h: segments.reduce((a, s) => a + s.canvas.height, 0), dpr, segs: segments.length,
    pw: doc ? fullWpx : (baseSeg0 ? baseSeg0.width : 0), ph: doc ? fullHpx : (baseSeg0 ? baseSeg0.height : 0),
    restored: restoredRecentId != null, sentToDrive, unsaved: hasUnsavedMarks(),
    incognito: !!(meta && meta.incognito), pages: pages.map((p) => p.k)
  };
  if (withThumb && st === "ready") c.thumb = rosterThumb();
  return c;
}
function rosterPost(m) {
  if (!rosterBc) return false;
  try { rosterBc.postMessage(Object.assign({ v: ROSTER_V, from: editorId }, m)); return true; }
  catch (_) { return false; }          // DataCloneError / closed channel
}
function rosterEmit(what) { for (const fn of rosterListeners) { try { fn(what); } catch (_) {} } }

// Called from init() right after wireTools(), before the no-job branch, so a ?recent=1 editor
// that later reopens a capture joins too. Every chrome.tabs call is feature-checked: an
// unguarded one crashed the whole editor in the test harness.
function rosterInit() {
  if (rosterStarted || typeof BroadcastChannel !== "function") return;
  rosterStarted = true;
  try { rosterBc = new BroadcastChannel(ROSTER_NAME); } catch (_) { rosterBc = null; return; }
  if (typeof rosterBc.unref === "function") rosterBc.unref();   // Node (the test harness) only: never keeps the process alive
  rosterBc.onmessage = (e) => { try { onRosterMsg(e.data); } catch (_) {} };
  rosterBc.onmessageerror = () => {    // a payload this tab could not deserialize
    for (const p of [...pendingGives.values()]) if (p.acked) settleGive(p, null, "clone");
  };
  try { if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(onPeerTabRemoved); } catch (_) {}
  try { document.addEventListener("resume", () => rosterChanged(true)); } catch (_) {}   // unfrozen: say so
  try { window.addEventListener("pagehide", rosterBye); } catch (_) {}
  rosterPost({ t: "who", reqId: rosterNewId(), wantThumb: false });
}

/* ---- suggestion bar: when to show, and its lifecycle (pure) ---- */
function shouldSuggest(settings) {
  // Only a FRESH capture offers a join: never one reopened from Recent, never an error page,
  // never a capture saved in parts (Join is disabled there), and only with the setting on.
  return !!jobId && restoredRecentId == null && !doc && myState() === "ready" && (settings || {}).joinSuggest !== false;
}
// state: { mode: "none"|"full"|"compact"|"closed", hiddenFor: null|"crop", shown: [capKey] }
function suggestNext(s, ev) {
  const live = s.mode === "full" || s.mode === "compact";
  const closed = { mode: "closed", hiddenFor: null, shown: [] };
  switch (ev.type) {
    case "show":      return ev.cards.length ? { mode: ev.streak >= 3 ? "compact" : "full", hiddenFor: null, shown: ev.cards.map((c) => c.capKey) } : { mode: "none", hiddenFor: null, shown: [] };
    case "export":    return s.mode === "full" ? Object.assign({}, s, { mode: "compact" }) : s;          // Download / Copy / PDF
    case "drive":     return live ? closed : s;                                                          // filed
    case "join":      return live ? closed : s;
    case "dismiss":   return live ? closed : s;
    case "dismissOne":
    case "partnerGone": { if (!live) return s; const shown = s.shown.filter((k) => k !== ev.capKey); return shown.length ? Object.assign({}, s, { shown }) : closed; }
    case "cropStart": return live ? Object.assign({}, s, { hiddenFor: "crop" }) : s;
    case "cropEnd":   return s.hiddenFor === "crop" ? Object.assign({}, s, { hiddenFor: null }) : s;   // Apply or Cancel
    case "restored":  return closed;                                                                     // content replaced
  }
  return s;
}
function rosterChanged(now) {
  if (hereTimer) { clearTimeout(hereTimer); hereTimer = null; }
  if (!rosterBc) return;
  const go = () => {
    hereTimer = null;
    const c = myCard(false);
    // An editor with nothing to offer (error page, empty ?recent=1 page) must not appear
    // anywhere - and one that just failed withdraws what it announced while capturing.
    if (c.state === "gone" || c.state === "empty") { rosterPost({ t: "bye" }); mirrorRemove(); return; }
    rosterPost({ t: "here", card: c }); mirrorWrite(c);
  };
  if (now) go(); else hereTimer = setTimeout(go, 1000);
}
function noteEdit() { editRev++; lastActive = Date.now(); rosterChanged(false); }
function noteVisibility(hidden) { lastActive = Date.now(); rosterChanged(hidden); }   // hidden: timers throttle, flush now
function rosterBye() {
  rosterPost({ t: "bye" });
  mirrorRemove();
  for (const p of [...pendingGives.values()]) settleGive(p, null, "closed");
}

// One key per editor: several tabs read-modify-writing ONE shared key lose each other's entries.
function mirrorWrite(c) {
  try {
    const p = chrome.storage.session.set({ [MIRROR_PREFIX + editorId]: c || myCard(false) });
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}
function mirrorRemove(id) {
  try { const p = chrome.storage.session.remove(MIRROR_PREFIX + (id || editorId)); if (p && p.catch) p.catch(() => {}); } catch (_) {}
}

// A tab holds one editor at a time. The 'bye' a page posts while it unloads never arrives
// (Chrome drops it - checked for close, reload and beforeunload), so a reloaded tab's new editor
// replaces the old card here, and a closed tab goes via chrome.tabs.onRemoved.
function upsertPeer(card) {
  if (card.tabId != null) for (const [id, c] of [...peers]) if (id !== card.editorId && c.tabId === card.tabId) { dropPeer(id, true); mirrorRemove(id); }
  peers.set(card.editorId, Object.assign({}, card, { seenAt: Date.now() }));
  rosterEmit("peers");
}
function dropPeer(id, quiet) {
  if (!peers.delete(id)) return;
  for (const p of [...pendingGives.values()]) if (p.peer.editorId === id) settleGive(p, null, "closed");
  if (!quiet) rosterEmit("peers");
}
function onPeerTabRemoved(tabId) {
  for (const [id, c] of [...peers]) if (c.tabId === tabId) { dropPeer(id); mirrorRemove(id); }
}

function onRosterMsg(m) {
  if (!m || m.v !== ROSTER_V || !m.from || m.from === editorId) return;
  if (m.to && m.to !== editorId) return;
  switch (m.t) {
    case "who": {
      const st = myState();
      if (st !== "gone" && st !== "empty") rosterPost({ t: "here", reqId: m.reqId, card: myCard(!!m.wantThumb) });
      return;
    }
    case "here": if (m.card && m.card.editorId === m.from) upsertPeer(m.card); return;
    case "bye": dropPeer(m.from); return;
    case "thumbReq": if (myState() === "ready") rosterPost({ t: "thumb", to: m.from, capKey: myCapKey(), rev: editRev, url: rosterThumb() }); return;
    case "thumb": { const c = peers.get(m.from); if (c && c.capKey === m.capKey) { c.thumb = m.url; c.thumbRev = m.rev; rosterEmit("thumb"); } return; }
    case "give": onGive(m); return;
    case "giving": {
      const p = pendingGives.get(m.reqId);
      if (!p || p.peer.editorId !== m.from || p.acked) return;
      p.acked = true; clearTimeout(p.timer);
      p.timer = setTimeout(() => settleGive(p, null, "timeout"), GIVE_PART_MS);
      if (p.onAck) { try { p.onAck(); } catch (_) {} }
      return;
    }
    case "part": { const p = pendingGives.get(m.reqId); if (p && p.peer.editorId === m.from) settleGive(p, m, null); return; }
    case "giveFail": { const p = pendingGives.get(m.reqId); if (p && p.peer.editorId === m.from) settleGive(p, null, m.reason || "failed"); return; }
  }
}

/* ---- source side ---- */
async function pagePng(src) {
  if (typeof Blob !== "undefined" && src instanceof Blob) return src;      // a page that came as a Blob: send it as is
  if (handoffPngCache.has(src)) return handoffPngCache.get(src);
  const blob = await canvasToBlob(src, "image/png");
  handoffPngCache.set(src, blob);
  return blob;
}
// The pages this editor hands over, snapshotted synchronously (the picture can change during
// the encode). A single capture is one page; a joined picture hands over EVERY page with the
// marks that sit wholly on it (in its own page px), so it can be joined again elsewhere. A mark
// crossing two of its pages stays behind.
function handoffSnapshot() {
  const t = stampTime || captureTime;
  if (!doc) {
    return [{ src: baseSeg0, capKey: myCapKey(), title: (meta && meta.title) || "", url: (meta && meta.url) || "",
      env: (meta && meta.env) || null, dpr, stampTime: t ? new Date(t).getTime() : null,
      barOn: !!(infoBar && !stampLocked), barBaked: !!stampLocked, wasCropped: !!wasCropped,
      w: baseSeg0 ? baseSeg0.width : 0, h: baseSeg0 ? baseSeg0.height : 0,
      annots: annotsForSave(), rev: editRev, pixRev, incognito: !!(meta && meta.incognito) }];
  }
  const rects = pageRects();
  return doc.parts.map((p) => {
    const r = rects.find((q) => q.pid === p.pid);
    const mine = annotations.filter((a) => { const pg = pagesOfMark(a, rects); return pg.size === 1 && pg.has(p.pid); });
    const local = { pid: p.pid, x: 0, y: 0, w: p.w, h: p.h, scale: 1, bx: 0, by: 0, bw: p.w, bh: p.h };
    return { src: p.src, capKey: p.pid === doc.hostPid ? myCapKey() : (p.capKey || null),
      title: (p.meta && p.meta.title) || p.label || "", url: (p.meta && p.meta.url) || "", env: (p.meta && p.meta.env) || null,
      dpr: p.dpr || 1, stampTime: p.stampTime ? new Date(p.stampTime).getTime() : null,
      barOn: !!p.barOn, barBaked: !!p.barBaked, wasCropped: !!p.wasCropped, w: p.w, h: p.h,
      annots: r ? remapAnnots(cloneAnnots(mine), [r], [local]) : [], rev: editRev, pixRev,
      incognito: !!(meta && meta.incognito) };
  });
}
async function onGive(m) {
  const fail = (reason) => rosterPost({ t: "giveFail", to: m.from, reqId: m.reqId, reason });
  if (m.at && Date.now() - m.at > GIVE_STALE_MS) return;          // queued while frozen; the asker gave up
  if (m.capKey !== myCapKey()) return fail("changed");            // this tab now shows another capture
  const st = myState();
  if (st !== "ready") return fail(st);
  if (docBusy) return fail("busy");
  rosterPost({ t: "giving", to: m.from, reqId: m.reqId });
  commitOpenInput();                                              // a half-typed label goes with the page
  cancelDrag();
  const pages = handoffSnapshot();
  try { for (const pg of pages) { pg.blob = await pagePng(pg.src); delete pg.src; } } catch (_) { return fail("encode"); }
  if (!rosterPost({ t: "part", to: m.from, reqId: m.reqId, pages })) fail("clone");
}

/* ---- host side ---- */
function settleGive(p, msg, err) {
  if (!pendingGives.has(p.reqId)) return;
  pendingGives.delete(p.reqId); clearTimeout(p.timer);
  if (err) { const e = new Error(err); e.reason = err; p.reject(e); return; }
  const pages = msg && Array.isArray(msg.pages) ? msg.pages : [];
  const bad = !pages.length || pages.some((pg) => !(pg && pg.blob instanceof Blob && pg.blob.size > 0 && pg.w > 0 && pg.h > 0));
  if (bad) { const e = new Error("empty"); e.reason = "empty"; p.reject(e); return; }
  p.resolve(pages);
}
function requestPages(peer, opts) {
  return new Promise((resolve, reject) => {
    const reqId = rosterNewId();
    const p = { reqId, peer, resolve, reject, acked: false, onAck: opts && opts.onAck };
    pendingGives.set(reqId, p);
    p.timer = setTimeout(() => { noAck(p); }, (opts && opts.ackMs) || GIVE_ACK_MS);
    if (!rosterPost({ t: "give", to: peer.editorId, reqId, capKey: peer.capKey, at: Date.now() })) settleGive(p, null, "post");
  });
}
function cancelPageRequests(peerId) {
  for (const p of [...pendingGives.values()]) if (!peerId || p.peer.editorId === peerId) settleGive(p, null, "cancelled");
}
async function noAck(p) {
  if (!pendingGives.has(p.reqId) || p.acked) return;
  const why = await probeTab(p.peer.tabId);
  settleGive(p, null, why);
}
async function probeTab(tabId) {
  if (tabId == null || !(chrome.tabs && chrome.tabs.get)) return "noanswer";
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t) return "closed";
    if (t.discarded) return "discarded";
    if (t.frozen) return "asleep";
    return "noanswer";
  } catch (_) { return "closed"; }
}
async function goToTab(tabId) {
  // Look the window up NOW: a tab dragged to another window keeps its id, not its windowId.
  const t = await chrome.tabs.get(tabId);
  if (t.discarded) { const e = new Error("discarded"); e.reason = "discarded"; throw e; }   // activating reloads it
  await chrome.tabs.update(tabId, { active: true });
  if (chrome.windows && chrome.windows.update) await chrome.windows.update(t.windowId, { focused: true });
  return t;
}
function waitForHere(id, ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const fn = (what) => { const c = peers.get(id); if (what === "peers" && c && c.seenAt >= start) { done(); resolve(c); } };
    const done = () => { rosterListeners.delete(fn); clearTimeout(tm); };
    const tm = setTimeout(() => { done(); const e = new Error("noanswer"); e.reason = "noanswer"; reject(e); }, ms);
    rosterListeners.add(fn);
  });
}
async function wakeAndRequest(peer) {
  const s = await probeTab(peer.tabId);
  if (s !== "asleep") { const e = new Error(s); e.reason = s; throw e; }   // never activate a discarded tab
  const back = myTabId;
  const woke = waitForHere(peer.editorId, 5000);
  await goToTab(peer.tabId);
  rosterPost({ t: "who", reqId: rosterNewId(), wantThumb: false });     // in case 'resume' did not fire
  await woke;
  return requestPages(peer, { onAck: () => { if (back != null) goToTab(back).catch(() => {}); } });
}
function requestThumb(peer) {
  // Only for the 1-2 cards on screen (and drawer rows as they render); the answer lands in peers.
  const c = peers.get(peer.editorId);
  if (c && c.thumb && c.thumbRev === c.rev) return false;
  return rosterPost({ t: "thumbReq", to: peer.editorId });
}
// What the tester reads when another tab's page could not be fetched.
function giveMessage(reason, peer) {
  const name = (peer && (peer.ownTitle || peer.title)) || "That capture";
  switch (reason) {
    case "closed": return name + "'s tab closed before it could send its picture. Pick another or add a file.";
    case "asleep": return name + "'s tab is asleep. Wake it, then try again.";
    case "discarded": return "The browser closed " + name + "'s tab to free memory, so its picture is gone. Use its downloaded file or capture it again.";
    case "changed": return "That tab now shows a different capture.";
    case "capturing": return name + " is still capturing. Try again in a moment.";
    case "busy": return name + " is busy. Try again in a moment.";
    case "cancelled": return null;
    default: return "Couldn't get " + name + "'s picture. Try again, or add its file.";
  }
}
function partFromPage(pg, peer) {
  return { src: pg.blob, w: pg.w, h: pg.h, dpr: pg.dpr || 1, origin: "tab",
    meta: { title: pg.title || "", url: pg.url || "", env: pg.env || null },
    stampTime: pg.stampTime ? new Date(pg.stampTime) : null, barOn: !!pg.barOn, barBaked: !!pg.barBaked,
    wasCropped: !!pg.wasCropped, capKey: pg.capKey || null, srcEditorId: peer ? peer.editorId : null };
}
// Join another open editor's page(s) into this capture. One retry when the source is merely slow
// to answer (all editors share one thread); an asleep tab is reported so the UI can offer Wake.
async function joinFromPeer(peer, opts) {
  opts = opts || {};
  const why = joinBlockedReason();
  if (why) return { ok: false, reason: why };
  if (!!peer.incognito !== !!(meta && meta.incognito)) return { ok: false, reason: "An incognito capture can only be joined with another incognito capture." };
  let pages;
  try {
    pages = opts.wake ? await wakeAndRequest(peer) : await requestPages(peer, { onAck: opts.onAck });
  } catch (e) {
    let reason = e && e.reason;
    if (reason === "noanswer" && !opts.wake) {
      try { pages = await requestPages(peer, { ackMs: 5000, onAck: opts.onAck }); reason = null; } catch (e2) { reason = e2 && e2.reason; }
    }
    if (reason === "closed") { dropPeer(peer.editorId); mirrorRemove(peer.editorId); }
    if (reason) return { ok: false, reason: giveMessage(reason, peer), code: reason, cancelled: reason === "cancelled" };
  }
  const incoming = pages.map((pg) => ({ part: partFromPage(pg, peer), marks: pg.annots || [], orderTime: pg.stampTime }));
  return joinPages(incoming, { via: "tab" });
}

/* ---- who to offer (pure) ---- */
function joinCandidates(list, me, now, dismissed) {
  const isJoined = (c) => Array.isArray(c.pages) && c.pages.length > 1;
  const hostOf = new Map();
  for (const c of list) if (isJoined(c)) for (const k of c.pages) if (k !== c.capKey) hostOf.set(k, c);
  const ok = (c) => c && c.state === "ready" && c.segs === 1 && c.capKey && c.capKey !== me.capKey &&
    !(me.pages || []).includes(c.capKey) && !c.sentToDrive && !dismissed.has(c.capKey) &&
    !!c.incognito === !!me.incognito && now - (c.lastActive || 0) <= JOIN_WINDOW_MS;
  const out = [], seen = new Set();
  for (const c of list) {
    const shown = hostOf.get(c.capKey) || c;     // a page inside another open joined image is shown as that image
    if (!ok(shown) || (!ok(c) && shown === c)) continue;
    if (shown.editorId === me.editorId || seen.has(shown.editorId)) continue;
    seen.add(shown.editorId); out.push(shown);
  }
  out.sort((a, b) => ((a.pageKey === me.pageKey) - (b.pageKey === me.pageKey)) || ((b.lastActive || 0) - (a.lastActive || 0)));
  return { cards: out, preselect: out.length === 1 ? out[0] : null };
}
// Every other ready editor this capture could take a page from (the Join drawer / badge): no
// 20-minute window and no dismissals here - the tester is asking.
function joinablePeers() {
  const me = myCard(false);
  return [...peers.values()].filter((c) => c.editorId !== editorId && c.capKey && c.capKey !== me.capKey &&
    !(me.pages || []).includes(c.capKey) && !!c.incognito === !!me.incognito && c.state !== "gone" && c.state !== "empty")
    .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
}
function sourceBandHost() {
  const me = myCapKey();
  if (!me) return null;
  let best = null;
  for (const c of peers.values()) {
    if (c.editorId === editorId || !Array.isArray(c.pages) || c.pages.length < 2 || !c.pages.includes(me)) continue;
    if (!best || (c.lastActive || 0) > (best.lastActive || 0)) best = c;
  }
  return best;
}
async function loadDismissed() {
  try {
    const all = (await chrome.storage.session.get(null)) || {};
    return new Set(Object.keys(all).filter((k) => k.startsWith(DISMISS_PREFIX)).map((k) => k.slice(DISMISS_PREFIX.length)));
  } catch (_) { return new Set(); }
}
async function rollCall(ms) {
  const reqId = rosterNewId();
  rosterPost({ t: "who", reqId, wantThumb: false });   // cards only: every editor shares one renderer thread
  await new Promise((r) => setTimeout(r, ms == null ? ROLLCALL_MS : ms));
  return [...peers.values()];
}
// The tab strip shows the page's name instead of "Full Page Capture" for every editor, so "the
// Details Report tab" in the Join messages is a tab the tester can find.
function syncDocTitle() {
  try { document.title = ((meta && meta.title) || "Capture") + " - Full Page Capture"; } catch (_) {}
}

// A capture reopened from Recent is a different capture for the roster (capKey recent:<id>), and
// never offers a join itself. A reload that brought its own joined picture back keeps its key.
function noteRestored(rec, opts) {
  if (!(opts && opts.reload)) restoredRecentId = rec.id;
  editRev++; pixRev++;
  syncDocTitle();
  rosterChanged(true);
}
