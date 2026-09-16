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
let captureTime = null;      // set when an older capture is restored, so the info bar keeps ITS time
let captureSettled = false;
let recentEnabled = false;   // Settings > "Keep recent captures" - opt-in, off until enabled
let currentRecentId = null;  // the Recent row this editor writes its annotations back into
let recentSaveTimer = null;  // true once the job finished (or failed); restoring a Recent capture before that would let late tiles paint over it

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
  if (msg.type === "error") return showError(msg.error);
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
function hasEnvLine() { return !!(envBar && meta && meta.env && meta.env.ua && meta.env.vw); }

function drawInfoBar(ctx, w, barH) {
  ctx.save();
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, barH);
  const line = Math.max(2, Math.round(2 * dpr));
  ctx.fillStyle = "#14b8a6";
  ctx.fillRect(0, barH - line, w, line);
  const pad = Math.round(16 * dpr);
  const fs = Math.round(13 * dpr);
  const rowH = barH - line;
  const twoLine = hasEnvLine();
  const y1 = twoLine ? Math.round(rowH * 0.31) : Math.round(rowH / 2);
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fs}px system-ui, "Segoe UI", Arial, sans-serif`;

  let timeStr = (captureTime || new Date()).toLocaleString();
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
  const urlText = fitText(ctx, meta.url || "", maxUrlW);
  if (urlText) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(urlText, pad, y1);
    // Remember where the URL sits so PDF export can lay a clickable link over it.
    infoBarLink = { x: pad, y: 0, w: ctx.measureText(urlText).width, h: barH, uri: meta.url || "" };
  } else {
    infoBarLink = null;
  }

  // Line 2: environment metadata (Browser · OS · Viewport · DPR)
  if (twoLine) {
    ctx.font = `500 ${Math.round(11.5 * dpr)}px system-ui, "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = "#9aa7bd";
    ctx.fillText(fitText(ctx, formatEnv(meta.env), w - pad * 2), pad, Math.round(rowH * 0.72));
  }
  ctx.restore();
}

function infoBarHeight() { return Math.max(28, Math.round((hasEnvLine() ? 52 : 34) * dpr)); }

function withInfoBar(base) {
  const barH = infoBarHeight();
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height + barH;
  const ctx = out.getContext("2d");
  drawInfoBar(ctx, out.width, barH);
  ctx.drawImage(base, 0, barH);
  return out;
}

// Swap segments[0] between the pristine capture and the bar-stamped version.
function applyInfoBar() {
  if (!baseSeg0 || !segments[0]) return;
  if (!infoBar) infoBarLink = null; // withInfoBar (which sets it) won't run when off
  const target = infoBar ? withInfoBar(baseSeg0) : baseSeg0;
  const seg = segments[0];
  if (seg.canvas === target) return;
  const before = segments[1] ? segments[1].canvas : (annotCanvas || cropOverlay);
  seg.canvas.remove();
  canvasHost.insertBefore(target, before);
  seg.canvas = target;
  seg.ctx = target.getContext("2d");
  seg.height = target.height;
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
  shiftAnnotList(annotations, dy);
  for (const s of undoStack) shiftAnnotList(s, dy);
  for (const s of redoStack) shiftAnnotList(s, dy);
}

function toggleInfoBar() {
  if (stampLocked || segments.length !== 1) return;
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
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushRecentSave(); });
  window.addEventListener("pagehide", flushRecentSave);
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
    // Never hijack keys while the user is typing in a field (e.g. the text-label input).
    const t = e.target;
    if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape" && el("recentDrawer") && !el("recentDrawer").hidden) { closeRecent(); return; }
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
function sanitize(name) {
  return (name || "screenshot").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "screenshot";
}
function pad(n) { return String(n).padStart(2, "0"); }
function buildFilename(ext) {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let host = "";
  try { host = new URL(meta.url).hostname.replace(/^www\./, ""); } catch (_) {}
  const base = (defaultSettings.filenameTemplate || "{title}-{date}")
    .replace(/{title}/g, sanitize(meta.title))
    .replace(/{date}/g, date)
    .replace(/{time}/g, time)
    .replace(/{host}/g, host || "page");
  return sanitize(base) + "." + ext;
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
      const blob = await canvasToBlob(flatten(segments[0]), type, q);
      await saveBlob(blob, buildFilename(ext));
      toast("Saved " + ext.toUpperCase());
    } else {
      const stem = buildFilename(ext).slice(0, -(ext.length + 1)); // drop the ".ext" reliably
      for (let i = 0; i < segments.length; i++) {
        const blob = await canvasToBlob(flatten(segments[i]), type, q);
        await saveBlob(blob, `${stem}-part${i + 1}.${ext}`);
      }
      toast(`Saved ${segments.length} ${ext.toUpperCase()} parts`);
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
    if (i === 0 && infoBar && infoBarLink && infoBarLink.uri) {
      const H = fc.height;
      image.link = {
        uri: infoBarLink.uri,
        rect: [infoBarLink.x, H - (infoBarLink.y + infoBarLink.h), infoBarLink.x + infoBarLink.w, H - infoBarLink.y]
      };
    }
    images.push(image);
  }
  return images;
}

async function downloadPdf() {
  const images = await buildPdfImages();
  const linked = images.some((im) => im.link);
  const blob = new Blob([FPCPDF.build(images)], { type: "application/pdf" });
  await saveBlob(blob, buildFilename("pdf"));
  toast(linked ? "Saved PDF — URL is clickable" : "Saved PDF");
}

async function doCopy() {
  try {
    const blob = await canvasToBlob(flatten(segments[0]), "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
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
  if (segments.length !== 1) return;
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
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!cropping || !dragStart) return;
    const b = ov.getBoundingClientRect();
    const cx = Math.max(0, Math.min(e.clientX - b.left, b.width));
    const cy = Math.max(0, Math.min(e.clientY - b.top, b.height));
    sel = { x: Math.min(dragStart.x, cx), y: Math.min(dragStart.y, cy), w: Math.abs(cx - dragStart.x), h: Math.abs(cy - dragStart.y) };
    updateRect(rect, sel);
    const scale = segments[0].canvas.width / segments[0].canvas.getBoundingClientRect().width;
    el("cropInfo").textContent = `${Math.round(sel.w * scale)} × ${Math.round(sel.h * scale)} px`;
  });
  window.addEventListener("mouseup", () => { dragStart = null; });
  ov._getSel = () => sel;
  // Called when the canvas is resized (zoom / window resize): a pixel selection made
  // at the old display size is no longer valid, so clear it and ask for a fresh drag.
  ov._reset = () => { sel = null; dragStart = null; rect.hidden = true; el("cropInfo").textContent = "Drag on the image to select a region"; };
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

  // Replace the old canvas + annotation layer (annotations are now baked in).
  displayed.remove();
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; annotCtx = null; }
  // Write the pre-crop markup out against the uncropped image it was actually drawn
  // on, then let go of that Recent row: from here the picture on screen no longer
  // matches the stored blob, so anything drawn next would be saved at crop-space
  // coordinates (and shifted by a bar that is now baked into the pixels).
  flushRecentSave();
  currentRecentId = null;
  annotations = []; undoStack = []; redoStack = [];
  canvasHost.insertBefore(out, cropOverlay);
  segments = [{ canvas: out, ctx, startY: 0, height: sh }];
  fullWpx = sw; fullHpx = sh;
  // The crop already baked in whatever bar state was showing; freeze the toggle.
  baseSeg0 = out;
  stampLocked = true;
  infoBarLink = null; // URL position no longer known after a crop; PDF link dropped
  reflectInfoBarBtn();
  wasCropped = true;
  updateDims();
  endCrop();
  applyZoom();
  maybeAnnot();
  toast("Cropped");
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

function beginDrag(a, p, e, handle) {
  setActiveAnnot(a);
  if (pendingSel && annotTool !== "whiteout") { clearPendingSel(); }
  activePointerId = e.pointerId;
  try { annotCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  drag = { a: a, sx: p.x, sy: p.y, moved: false, handle: handle || null,
    orig: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, bbox: annotBBox(a),
            points: a.points ? a.points.map((q) => ({ x: q.x, y: q.y })) : null } };
  annotCanvas.style.cursor = handle ? (HANDLE_CURSOR[handle] || "move") : "move";
  renderAnnots();
}

function onAnnotDown(e) {
  if (!annotating || !annotCanvas || e.target !== annotCanvas) return;
  if (e.button !== 0 || !e.isPrimary) return;   // primary mouse button / first touch only
  if (liveAnnot) return;                         // one stroke at a time (ignore extra touches)
  e.preventDefault();
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
}
function onAnnotMove(e) {
  if (drag && e.pointerId === activePointerId) {
    const p = evtToImg(e);
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    // Snapshot once, on the first real movement, so a plain click leaves no undo entry.
    if (!drag.moved) { if (Math.hypot(dx, dy) < 1) return; drag.moved = true; pushHistory(); activeTouched = true; }
    if (drag.handle) resizeAnnot(drag.a, drag.orig, drag.handle, dx, dy);
    else translateAnnot(drag.a, drag.orig, dx, dy);
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
  if (liveAnnot.type === "pen" || liveAnnot.type === "highlight") liveAnnot.points.push(p);
  renderAnnots();
}
function onAnnotUp(e) {
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
// Call BEFORE mutating `annotations` so undo can restore the previous state.
function pushHistory() {
  undoStack.push(cloneAnnots(annotations));
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  scheduleRecentSave();
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
  if (isLabel) activeAnnot.size = next; else activeAnnot.width = next;
  renderAnnots();
}
function applyActiveColour() {
  if (!activeAnnot || activeAnnot.type === "stamp") return;  // stamps keep their meaning-colour
  if (activeAnnot.color === annotColor) return;
  touchActive();
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
      ctx.fillRect(x, y, w, h);
      break;
    }
    case "step": {
      // Auto-numbered by position among step badges (so undo/redo renumbers cleanly).
      const steps = annotations.filter((s) => s.type === "step");
      const n = steps.indexOf(a) + 1 || steps.length + 1;
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

function drawBlur(ctx, x, y, w, h, strength) {
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

function annotUndo() {
  cancelDrag();
  if (!undoStack.length) return;
  redoStack.push(cloneAnnots(annotations));
  annotations = undoStack.pop();
  clearActiveAnnot();            // the snapshot holds fresh objects; the old reference is stale
  renderAnnots();
  scheduleRecentSave();
}
function annotRedo() {
  cancelDrag();
  if (!redoStack.length) return;
  undoStack.push(cloneAnnots(annotations));
  annotations = redoStack.pop();
  clearActiveAnnot();
  renderAnnots();
  scheduleRecentSave();
}
function annotClear() {
  cancelDrag();
  if (!annotations.length) return;
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
  const dy = infoBar ? -infoBarHeight() : 0;
  const list = cloneAnnots(annotations);
  if (dy) shiftAnnotList(list, dy);
  return list;
}
async function recentUpdateAnnots(id, annots) {
  const db = await dbOpen();
  const rec = await dbRun(db, "readonly", (st) => st.get(id));
  if (!rec) return;
  rec.annots = annots;
  await dbRun(db, "readwrite", (st) => { st.put(rec); });
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
  try { recentUpdateAnnots(id, annotsForSave()).catch(() => {}); } catch (_) {}
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
    if (!baseSeg0 || segments.length !== 1 || captureTime) return;   // single-image captures only; never re-save a restored one
    const src = baseSeg0;
    const tw = 220, th = Math.min(400, Math.max(1, Math.round(src.height * tw / src.width)));
    const tc = document.createElement("canvas"); tc.width = tw; tc.height = th;
    tc.getContext("2d").drawImage(src, 0, 0, src.width, src.width * th / tw, 0, 0, tw, th);
    const thumb = tc.toDataURL("image/jpeg", 0.7);
    const m = meta || {};
    const id = Date.now();
    currentRecentId = id;                       // later annotation edits update THIS row
    src.toBlob((blob) => {
      if (!blob) return;
      recentPut({ id, ts: id, title: m.title || "", url: m.url || "", dpr, w: src.width, h: src.height, env: m.env || null, thumb, blob, annots: [] }).catch(() => {});
    }, "image/jpeg", 0.85);
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
    s.textContent = timeAgo(r.ts) + "  \u00b7  " + r.w + "\u00d7" + r.h + " px" + (n ? "  \u00b7  " + n + " annotation" + (n > 1 ? "s" : "") : "");
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

async function restoreRecent(id) {
  if (jobId && !captureSettled) { toast("Wait for the current capture to finish, then reopen a recent one"); return; }
  let rec = null;
  try { rec = await recentGet(id); } catch (_) {}
  if (!rec) { toast("That capture is no longer available"); return; }
  if (annotations.length && !confirm("Replace the current image? Annotations on it will be lost.")) return;
  let bmp;
  try { bmp = await createImageBitmap(rec.blob); } catch (_) { toast("Couldn't load that capture"); return; }

  // Reset the editor to a fresh single-image state.
  if (annotating) exitAnnot();
  try { endCrop(); } catch (_) {}
  for (const s of segments) s.canvas.remove();
  if (annotCanvas) { annotCanvas.remove(); annotCanvas = null; annotCtx = null; }
  annotations = []; undoStack = []; redoStack = []; liveAnnot = null; drag = null; clearActiveAnnot(); clearPendingSel();

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
  if (rec.annots && rec.annots.length) {
    annotations = cloneAnnots(rec.annots);
    if (infoBar) shiftAnnotList(annotations, infoBarHeight());
    setupAnnotationLayer();
    renderAnnots();
  }
  reflectInfoBarBtn(); updateDims(); applyZoom();
  closeRecent();
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
    // Reveal the "Copy link" button so the link can be re-copied at any time — even if
    // the auto-copy below fails (tab not focused) or the clipboard later gets overwritten
    // by a Ctrl+C / Copy (which puts the image on the clipboard, replacing this link).
    const clBtn = el("copyLink"); if (clBtn) clBtn.hidden = false;
    ok = true;
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

/* ------------------------- UI bits ------------------------- */
function showError(message) {
  aborted = true; // stop any further tile drawing / finalize from racing over the error
  settleCapture();
  progressWrap.hidden = true;
  stage.hidden = true;
  tools.hidden = true;
  errorWrap.hidden = false;
  errorMsg.textContent = message || "Something went wrong.";
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
