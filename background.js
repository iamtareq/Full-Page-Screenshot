/* Full Page Capture — background service worker
 *
 * Orchestrates the capture:
 *   1. Validate the active tab.
 *   2. Inject helper functions (scroll / measure / hide fixed elements) via chrome.scripting.
 *   3. Repeatedly scroll the page and call chrome.tabs.captureVisibleTab, respecting the
 *      ~2 calls/second quota with a spacing guard + retry/backoff.
 *   4. Hand the collected tiles to result.html, which stitches + exports them.
 *
 * All heavy image work (stitching, PNG/JPG/PDF encoding, downloads) happens in result.html,
 * a normal DOM page — the service worker only shuttles data. This sidesteps every
 * service-worker binary limitation (no OffscreenCanvas juggling, no URL.createObjectURL).
 */

const RESULT_PAGE = "result.html";
const CAPTURE_GAP_MS = 520; // minimum spacing between captureVisibleTab calls (quota is ~2/s)
const SMOOTH_MS = 460;      // smooth-scroll glide per section (fills most of the capture gap)

// Job store: jobId -> { meta, tiles } | { error }
const jobs = new Map();
let jobCounter = 1;
let lastCaptureAt = 0;
// Tabs with a capture currently in flight — prevents two overlapping captures
// (e.g. shortcut mashing) from corrupting each other's scroll/tiles.
const capturingTabs = new Set();

const RESTRICTED_PREFIXES = [
  "chrome://", "edge://", "brave://", "opera://", "vivaldi://", "about:",
  "chrome-extension://", "moz-extension://", "devtools://", "view-source:",
  "https://chrome.google.com/webstore", "https://chromewebstore.google.com",
  "https://microsoftedge.microsoft.com/addons"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRestricted(url) {
  if (!url) return true;
  return RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

async function getSettings() {
  const defaults = {
    format: "png",
    jpegQuality: 0.92,
    tileDelay: 130,
    preScroll: false,
    hideFixed: true,
    smoothScroll: true,
    filenameTemplate: "{title}-{date}"
  };
  try {
    const s = await chrome.storage.sync.get("settings");
    return Object.assign(defaults, s.settings || {});
  } catch (_) {
    return defaults;
  }
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || "#4f46e5" });
    chrome.action.setBadgeText({ text: text || "" });
  } catch (_) {}
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/* ---- captureVisibleTab with spacing + retry (handles the per-second quota) ---- */
async function captureVisible(windowId) {
  const now = Date.now();
  const wait = lastCaptureAt + CAPTURE_GAP_MS - now;
  if (wait > 0) await sleep(wait);

  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureAt = Date.now();
      if (!dataUrl) throw new Error("Empty capture");
      return dataUrl;
    } catch (e) {
      lastErr = e;
      await sleep(650 + attempt * 200); // back off (usually the MAX_CAPTURE quota)
    }
  }
  throw lastErr || new Error("captureVisibleTab failed");
}

/* ---------------- Injected page functions (run in the target tab) ---------------- */
// These must be fully self-contained: no references to outer scope.

function fpcPrepare(opts) {
  const de = document.documentElement;
  const body = document.body;
  const clientW = de.clientWidth;
  const clientH = de.clientHeight;
  const fullW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0, clientW);
  const fullH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, clientH);
  const dpr = window.devicePixelRatio || 1;
  // On RTL-rooted documents Blink renders the vertical scrollbar on the LEFT, so
  // the content the stitcher should keep is the RIGHT part of each captured tile.
  let scrollbarLeft = false;
  try {
    scrollbarLeft = getComputedStyle(de).direction === "rtl" && (window.innerWidth - clientW) > 0;
  } catch (_) {}

  const state = {
    prevX: window.scrollX,
    prevY: window.scrollY,
    prevScrollBehavior: de.style.scrollBehavior,
    fixed: [],
    saved: null,
    hidden: false
  };
  de.style.scrollBehavior = "auto";

  if (opts && opts.hideFixed && body) {
    const nodes = body.getElementsByTagName("*");
    const candidates = [body];
    for (let i = 0; i < nodes.length; i++) candidates.push(nodes[i]);
    for (const el of candidates) {
      if (!el || el.nodeType !== 1) continue;
      let pos;
      try { pos = getComputedStyle(el).position; } catch (_) { continue; }
      if (pos === "fixed" || pos === "sticky") state.fixed.push(el);
    }
  }
  window.__fpc = state;
  return { clientW, clientH, fullW, fullH, dpr, scrollbarLeft,
    ua: navigator.userAgent, vw: window.innerWidth, vh: window.innerHeight };
}

function fpcScrollTo(x, y) {
  window.scrollTo(x, y);
  return { x: window.scrollX, y: window.scrollY };
}

// Smoothly glide to (x,y) over `duration` ms, then settle exactly on target.
// Returns the actual scroll position. Runs in the page via requestAnimationFrame.
async function fpcSmoothScrollTo(x, y, duration) {
  const sx = window.scrollX, sy = window.scrollY;
  const dx = x - sx, dy = y - sy;
  if (duration <= 0 || (dx === 0 && dy === 0)) {
    window.scrollTo(x, y);
    return { x: window.scrollX, y: window.scrollY };
  }
  // Trapezoidal velocity: gently ramp up, hold a constant speed through the middle,
  // gently ramp down into the stop. Soft starts/stops (no abrupt "wall" like linear)
  // without the mid-glide rush of ease-in-out — the smoothest feel for stop-and-go.
  const A = 0.28;             // fraction of the glide spent ramping (each side)
  const V = 1 / (1 - A);     // constant-phase velocity so the whole glide covers 1
  const ease = (t) => {
    if (t < A) return V * t * t / (2 * A);
    if (t < 1 - A) return V * (A / 2) + V * (t - A);
    const td = t - (1 - A);
    return V * (A / 2) + V * (1 - 2 * A) + V * (td - td * td / (2 * A));
  };
  const start = performance.now();
  await new Promise((resolve) => {
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const k = ease(t);
      window.scrollTo(sx + dx * k, sy + dy * k);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  window.scrollTo(x, y);
  return { x: window.scrollX, y: window.scrollY };
}

function fpcHideFixed() {
  const st = window.__fpc;
  if (!st || st.hidden) return;
  st.saved = [];
  for (const el of st.fixed) {
    st.saved.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
    el.style.setProperty("visibility", "hidden", "important");
  }
  st.hidden = true;
}

function fpcRestore() {
  const st = window.__fpc;
  if (!st) return;
  if (st.saved) {
    for (const [el, val, prio] of st.saved) {
      el.style.removeProperty("visibility");
      if (val) el.style.setProperty("visibility", val, prio || "");
    }
  }
  document.documentElement.style.scrollBehavior = st.prevScrollBehavior || "";
  window.scrollTo(st.prevX, st.prevY);
  delete window.__fpc;
}

async function fpcPreScroll() {
  const de = document.documentElement;
  const body = document.body;
  const h = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, de.clientHeight);
  const maxY = Math.max(0, h - window.innerHeight);
  const startY = window.scrollY;
  if (maxY <= 0) return true; // fits on one screen — nothing to pre-load
  const prevSB = de.style.scrollBehavior;
  de.style.scrollBehavior = "auto";
  const glide = (from, to, dur) => new Promise((resolve) => {
    if (dur <= 0 || from === to) { window.scrollTo(0, to); return resolve(); }
    const start = performance.now(), d = to - from;
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      window.scrollTo(0, from + d * t);
      if (t < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
  // Smoothly glide to the bottom (triggers lazy-load) and back — no jumpy jerk.
  const downDur = Math.min(1500, Math.max(450, maxY / 3.5));
  await glide(startY, maxY, downDur);
  await new Promise((r) => setTimeout(r, 120));
  await glide(maxY, startY, Math.min(700, downDur));
  await new Promise((r) => setTimeout(r, 80));
  de.style.scrollBehavior = prevSB || "";
  return true;
}

function fpcVisibleMeta() {
  return {
    clientW: document.documentElement.clientWidth,
    clientH: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio || 1,
    ua: navigator.userAgent, vw: window.innerWidth, vh: window.innerHeight
  };
}

// Injected: draw a selection overlay and resolve with the chosen rectangle in PAGE
// coordinates { x, y, w, h, dpr } (CSS px), or null if cancelled. Dragging to the
// viewport edge auto-scrolls, so a region taller/wider than the screen can be picked.
function fpcSelectRegion() {
  return new Promise((resolve) => {
    // Tear down any prior, still-pending instance (overlay + its listeners).
    if (window.__fpcSelCleanup) { try { window.__fpcSelCleanup(); } catch (_) {} }
    const stale = document.getElementById("__fpc_sel");
    if (stale) stale.remove();

    const dpr = window.devicePixelRatio || 1;
    const SHADE = "rgba(15,23,42,.4)";
    const token = {};
    window.__fpcSelToken = token;
    const de = document.documentElement;
    const prevSB = de.style.scrollBehavior;
    de.style.scrollBehavior = "auto"; // keep auto-scroll instant, not animated

    const root = document.createElement("div");
    root.id = "__fpc_sel";
    root.style.cssText = "position:fixed;inset:0;z-index:2147483647;margin:0;padding:0;cursor:crosshair;touch-action:none;";
    // Pre-drag full dim; during drag we dim with 4 cheap solid rectangles around the
    // box instead of a giant repainted box-shadow (which caused scroll stutter).
    const shade = document.createElement("div");
    shade.style.cssText = "position:absolute;inset:0;background:" + SHADE + ";";
    const mkDim = () => { const d = document.createElement("div"); d.style.cssText = "position:absolute;display:none;background:" + SHADE + ";"; return d; };
    const dimT = mkDim(), dimB = mkDim(), dimL = mkDim(), dimR = mkDim();
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;display:none;border:2px solid #6366f1;outline:1px solid rgba(255,255,255,.5);";
    const tag = document.createElement("div");
    tag.style.cssText = "position:absolute;display:none;background:#4f46e5;color:#fff;font:600 12px/1 system-ui,Segoe UI,Arial;padding:4px 7px;border-radius:5px;white-space:nowrap;";
    const hint = document.createElement("div");
    hint.textContent = "Drag to select — reach an edge to scroll   ·   Esc to cancel";
    hint.style.cssText = "position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(17,24,39,.94);color:#fff;font:600 13px/1 system-ui,Segoe UI,Arial;padding:9px 15px;border-radius:9px;";
    root.appendChild(shade);
    root.appendChild(dimT); root.appendChild(dimB); root.appendChild(dimL); root.appendChild(dimR);
    root.appendChild(box); root.appendChild(tag); root.appendChild(hint);
    de.appendChild(root);

    // Anchor stored in PAGE coords; current pointer stored in CLIENT coords.
    let startPX = 0, startPY = 0, curCX = 0, curCY = 0, dragging = false, done = false, raf = 0;

    const pageRect = () => {
      const curPX = curCX + window.scrollX, curPY = curCY + window.scrollY;
      return { x: Math.min(startPX, curPX), y: Math.min(startPY, curPY), w: Math.abs(curPX - startPX), h: Math.abs(curPY - startPY) };
    };
    const setBox = (el, l, t, w, h) => {
      el.style.display = "block";
      el.style.left = l + "px"; el.style.top = t + "px";
      el.style.width = Math.max(0, w) + "px"; el.style.height = Math.max(0, h) + "px";
    };
    function paint() {
      const r = pageRect();
      shade.style.display = "none";
      const vw = window.innerWidth, vh = window.innerHeight;
      const vx = r.x - window.scrollX, vy = r.y - window.scrollY; // page -> viewport
      box.style.display = "block";
      box.style.left = vx + "px"; box.style.top = vy + "px"; box.style.width = r.w + "px"; box.style.height = r.h + "px";
      // Dim around the box (clipped to the viewport) with four solid rectangles.
      const bx0 = Math.max(0, Math.min(vw, vx)), by0 = Math.max(0, Math.min(vh, vy));
      const bx1 = Math.max(0, Math.min(vw, vx + r.w)), by1 = Math.max(0, Math.min(vh, vy + r.h));
      setBox(dimT, 0, 0, vw, by0);
      setBox(dimB, 0, by1, vw, vh - by1);
      setBox(dimL, 0, by0, bx0, by1 - by0);
      setBox(dimR, bx1, by0, vw - bx1, by1 - by0);
      tag.style.display = "block";
      tag.textContent = Math.round(r.w) + " × " + Math.round(r.h);
      let tt = vy + r.h + 8;
      if (tt > vh - 24) tt = vy - 26;
      tag.style.left = Math.max(4, vx) + "px";
      tag.style.top = Math.max(4, Math.min(vh - 22, tt)) + "px";
    }
    function tick() {
      if (!dragging) return;
      const EDGE = 60, MAX = 16;              // gentler than before to feel controllable
      const ramp = (d) => Math.ceil(Math.pow(Math.min(1, d / EDGE), 2) * MAX); // ease-in
      let vy = 0, vx = 0;
      if (curCY < EDGE) vy = -ramp(EDGE - curCY);
      else if (curCY > window.innerHeight - EDGE) vy = ramp(curCY - (window.innerHeight - EDGE));
      if (curCX < EDGE) vx = -ramp(EDGE - curCX);
      else if (curCX > window.innerWidth - EDGE) vx = ramp(curCX - (window.innerWidth - EDGE));
      if (vx || vy) { window.scrollBy(vx, vy); paint(); }
      raf = requestAnimationFrame(tick);
    }
    function finish(res) {
      if (done) return; done = true;
      if (raf) cancelAnimationFrame(raf);
      root.remove();
      de.style.scrollBehavior = prevSB || "";
      window.removeEventListener("keydown", onKey, true);
      if (window.__fpcSelToken === token) { window.__fpcSelToken = null; window.__fpcSelCleanup = null; }
      resolve(res);
    }
    function cancel() { dragging = false; if (raf) cancelAnimationFrame(raf); finish(null); }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } }

    root.addEventListener("contextmenu", (e) => e.preventDefault());
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      if (dragging || done) return; // one drag / one rAF loop only (ignore a 2nd pointer)
      dragging = true;
      curCX = e.clientX; curCY = e.clientY;
      startPX = e.clientX + window.scrollX; startPY = e.clientY + window.scrollY;
      try { root.setPointerCapture(e.pointerId); } catch (_) {}
      paint(); e.preventDefault();
      raf = requestAnimationFrame(tick);
    });
    root.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      curCX = e.clientX; curCY = e.clientY; paint();
    });
    root.addEventListener("pointerup", () => {
      if (!dragging) return; dragging = false;
      if (raf) cancelAnimationFrame(raf);
      const r = pageRect();
      const docW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0, de.clientWidth);
      const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight);
      // Clamp BOTH edges to the document, so overshooting past x=0/y=0 doesn't leave
      // the far edge oversized.
      const x0 = Math.max(0, Math.min(r.x, docW)), y0 = Math.max(0, Math.min(r.y, docH));
      const x1 = Math.max(0, Math.min(r.x + r.w, docW)), y1 = Math.max(0, Math.min(r.y + r.h, docH));
      const w = x1 - x0, h = y1 - y0;
      if (w < 4 || h < 4) { finish(null); return; }
      finish({ x: x0, y: y0, w, h, dpr });
    });
    // Recover if the gesture is taken over (touch scroll/palm) or the pointer is lost
    // off-window — otherwise the overlay would be stranded on the page.
    root.addEventListener("pointercancel", cancel);
    root.addEventListener("lostpointercapture", () => { if (dragging) cancel(); });

    window.__fpcSelCleanup = () => finish(null);
    window.addEventListener("keydown", onKey, true);
  });
}

// Injected: hover a DOM element to highlight it, click to capture just that element.
// Resolves the element's PAGE rect { x, y, w, h, dpr } (CSS px), or null if cancelled.
function fpcSelectElement() {
  return new Promise((resolve) => {
    if (window.__fpcElCleanup) { try { window.__fpcElCleanup(); } catch (_) {} }
    const de = document.documentElement;
    const dpr = window.devicePixelRatio || 1;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid #6366f1;background:rgba(99,102,241,.14);box-shadow:0 0 0 2px rgba(255,255,255,.5),0 0 0 9999px rgba(15,23,42,.3);";
    const tag = document.createElement("div");
    tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;background:#4f46e5;color:#fff;font:600 12px/1 system-ui,Segoe UI,Arial;padding:4px 7px;border-radius:5px;white-space:nowrap;";
    const hint = document.createElement("div");
    hint.textContent = "Hover an element · click to capture · Esc to cancel";
    hint.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;top:14px;left:50%;transform:translateX(-50%);background:rgba(17,24,39,.94);color:#fff;font:600 13px/1 system-ui,Segoe UI,Arial;padding:9px 15px;border-radius:9px;";
    de.appendChild(box); de.appendChild(tag); de.appendChild(hint);
    const prevCursor = de.style.cursor;
    de.style.cursor = "crosshair";
    let current = null, done = false;

    function highlight(el) {
      current = el;
      if (!el || el === de || el === document.body) { box.style.display = "none"; tag.style.display = "none"; return; }
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { box.style.display = "none"; tag.style.display = "none"; return; }
      box.style.display = "block";
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.width = r.width + "px"; box.style.height = r.height + "px";
      let name = el.tagName.toLowerCase();
      if (el.id) name += "#" + el.id;
      else if (el.classList && el.classList.length) name += "." + el.classList[0];
      tag.style.display = "block";
      tag.textContent = name + "   " + Math.round(r.width) + "×" + Math.round(r.height);
      let tt = r.top - 24; if (tt < 4) tt = r.top + 4;
      tag.style.left = Math.max(4, r.left) + "px"; tag.style.top = Math.max(4, tt) + "px";
    }
    function cleanup() {
      box.remove(); tag.remove(); hint.remove();
      de.style.cursor = prevCursor || "";
      for (const ev of ["mousemove", "mousedown", "mouseup", "click", "contextmenu",
        "pointerdown", "pointerup", "pointermove"]) document.removeEventListener(ev, handlers[ev], true);
      window.removeEventListener("keydown", onKey, true);
      window.__fpcElCleanup = null;
    }
    function finish(res) { if (done) return; done = true; cleanup(); resolve(res); }
    function onMove(e) { highlight(document.elementFromPoint(e.clientX, e.clientY)); }
    function block(e) { e.preventDefault(); e.stopPropagation(); }
    function isFixed(el) {
      for (let n = el; n && n !== de; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }
    function onClick(e) {
      e.preventDefault(); e.stopPropagation();
      const el = current || document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === de || el === document.body) { finish(null); return; }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { finish(null); return; }
      if (isFixed(el)) {
        // Pinned to the viewport — capture it in place (no scroll-tiling).
        finish({ x: Math.max(0, r.left), y: Math.max(0, r.top), w: r.width, h: r.height,
          dpr, fixed: true, vw: window.innerWidth, vh: window.innerHeight });
        return;
      }
      const docW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0, de.clientWidth);
      const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight);
      const x = Math.max(0, r.left + window.scrollX), y = Math.max(0, r.top + window.scrollY);
      finish({ x, y, w: Math.min(r.width, docW - x), h: Math.min(r.height, docH - y), dpr, fixed: false });
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); } }
    // Block ALL press/pointer events (capture phase) so the page can't navigate/mutate
    // while picking; mousemove still drives the highlight, click still selects.
    const handlers = { mousemove: onMove, mousedown: block, mouseup: block, click: onClick,
      contextmenu: block, pointerdown: block, pointerup: block, pointermove: block };
    for (const ev in handlers) document.addEventListener(ev, handlers[ev], true);
    window.addEventListener("keydown", onKey, true);
    window.__fpcElCleanup = () => finish(null);
  });
}

/* ------------------------------- Step planning ------------------------------- */
// Scroll positions whose viewports cover the span [start, start+size] along one axis.
function tilePositions(start, size, view, full) {
  if (view <= 0) return [0];
  const maxScroll = Math.max(0, full - view);
  const end = start + size;
  let p = Math.max(0, Math.min(start, maxScroll));
  const out = [p];
  while (p + view < end && p < maxScroll) {
    p = Math.min(p + view, maxScroll);
    if (out[out.length - 1] === p) break;
    out.push(p);
  }
  return out;
}

function clampRegion(sel, m) {
  const x = Math.max(0, Math.min(sel.x, m.fullW));
  const y = Math.max(0, Math.min(sel.y, m.fullH));
  return { x, y, w: Math.max(1, Math.min(sel.w, m.fullW - x)), h: Math.max(1, Math.min(sel.h, m.fullH - y)) };
}

// Scroll through the page tile-by-tile covering `region` (CSS page coords), capture
// each viewport, and hand the tiles + region to the result page for stitching.
async function tiledCapture(o) {
  const { exec, windowId, tab, jobId, settings, metrics, region, mode } = o;
  const { clientW, clientH, fullW, fullH, dpr, scrollbarLeft } = metrics;
  const xs = tilePositions(region.x, region.w, clientW, fullW);
  const ys = tilePositions(region.y, region.h, clientH, fullH);
  const total = xs.length * ys.length;
  const multi = total > 1;

  const tiles = [];
  let count = 0, rowIndex = 0;
  for (const y of ys) {
    for (const x of xs) {
      const smooth = settings.smoothScroll && multi;
      const pos = smooth
        ? await exec(fpcSmoothScrollTo, [x, y, SMOOTH_MS])
        : await exec(fpcScrollTo, [x, y]);
      // Short settle when gliding — the glide already ends on the final frame, so only
      // a couple of frames are needed for it to paint. Keeps the pause between glides
      // brief so the stop-and-go is barely noticeable.
      await sleep(smooth ? Math.min(settings.tileDelay, 55) : settings.tileDelay);
      const dataUrl = await captureVisible(windowId);
      tiles.push({ dataUrl, x: pos ? pos.x : x, y: pos ? pos.y : y });
      count++;
      setBadge(String(Math.min(99, Math.round((count / total) * 100))));
    }
    // Hide fixed/sticky elements after the first full row (multi-tile only) so a
    // fixed header stays in row 0 and doesn't repeat down the rest.
    if (rowIndex === 0 && multi && settings.hideFixed) {
      try { await exec(fpcHideFixed); } catch (_) {}
    }
    rowIndex++;
  }
  try { await exec(fpcRestore); } catch (_) {}
  setBadge("");

  return openResult(jobId, {
    meta: {
      mode, title: tab.title || "screenshot", url: tab.url,
      dpr, clientW, clientH, fullW, fullH, scrollbarLeft: !!scrollbarLeft, region,
      env: { ua: metrics.ua, vw: metrics.vw, vh: metrics.vh, dpr }
    },
    tiles
  });
}

async function countdown(seconds) {
  for (let i = seconds; i > 0; i--) { setBadge(String(i), "#0ea5e9"); await sleep(1000); }
}

/* ------------------------------- Orchestration ------------------------------- */
async function runCapture(tab, mode, delay) {
  const jobId = String(jobCounter++);
  if (!tab) return openResult(jobId, { error: "No active tab." });
  if (isRestricted(tab.url)) {
    return openResult(jobId, {
      error: "This page can’t be captured. Browser system pages, the Web Store and extension pages are off-limits to all extensions."
    });
  }
  // Ignore a second trigger while this tab is still being captured.
  if (capturingTabs.has(tab.id)) return;
  capturingTabs.add(tab.id);

  const exec = (func, args) =>
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, func, args: args || [] })
      .then((res) => (res && res[0] ? res[0].result : undefined));

  const settings = await getSettings();
  const windowId = tab.windowId;

  try {
    if (delay > 0 && (mode === "full" || mode === "visible")) {
      await countdown(delay);
      // After the wait, make sure the intended tab is still the active one.
      const [act] = await chrome.tabs.query({ active: true, windowId });
      if (!act || act.id !== tab.id) { setBadge(""); return; }
    }
    setBadge("…");

    if (mode === "visible") {
      const dataUrl = await captureVisible(windowId);
      const m = (await exec(fpcVisibleMeta)) || { clientW: 0, clientH: 0, dpr: 1 };
      setBadge("");
      return openResult(jobId, {
        meta: { mode: "visible", title: tab.title || "screenshot", url: tab.url, dpr: m.dpr,
          env: m.ua ? { ua: m.ua, vw: m.vw, vh: m.vh, dpr: m.dpr } : undefined },
        tiles: [{ dataUrl, x: 0, y: 0 }]
      });
    }

    if (mode === "region") {
      const sel = await exec(fpcSelectRegion);   // {x,y,w,h,dpr} PAGE coords, or null if cancelled
      if (!sel) { setBadge(""); return; }        // user pressed Esc / no selection — no result tab
      // captureVisibleTab grabs the window's active tab; make sure it's still ours.
      const [act] = await chrome.tabs.query({ active: true, windowId });
      if (!act || act.id !== tab.id) { setBadge(""); return; }
      const metrics = await exec(fpcPrepare, [{ hideFixed: settings.hideFixed }]);
      if (!metrics) throw new Error("Could not read the page. Reload the page and try again.");
      const region = clampRegion(sel, metrics);
      return await tiledCapture({ exec, windowId, tab, jobId, settings, metrics, region, mode: "region" });
    }

    if (mode === "element") {
      const sel = await exec(fpcSelectElement);  // element rect {x,y,w,h,dpr,fixed}, or null
      if (!sel) { setBadge(""); return; }
      const [act] = await chrome.tabs.query({ active: true, windowId });
      if (!act || act.id !== tab.id) { setBadge(""); return; }
      if (sel.fixed) {
        // Fixed/pinned element — it stays in the viewport, so capture once and crop in
        // place (scroll-tiling would read the wrong, scrolled content). sel.x/y are
        // viewport coords; region maps them via a single (0,0) tile.
        const m = (await exec(fpcVisibleMeta)) || { dpr: sel.dpr, ua: "", vw: sel.vw, vh: sel.vh };
        const dataUrl = await captureVisible(windowId);
        setBadge("");
        return openResult(jobId, {
          meta: {
            mode: "region", title: tab.title || "screenshot", url: tab.url, dpr: sel.dpr,
            clientW: sel.vw, clientH: sel.vh, fullW: sel.vw, fullH: sel.vh, scrollbarLeft: false,
            region: { x: sel.x, y: sel.y, w: sel.w, h: sel.h },
            env: m.ua ? { ua: m.ua, vw: m.vw, vh: m.vh, dpr: m.dpr } : undefined
          },
          tiles: [{ dataUrl, x: 0, y: 0 }]
        });
      }
      const metrics = await exec(fpcPrepare, [{ hideFixed: settings.hideFixed }]);
      if (!metrics) throw new Error("Could not read the page. Reload the page and try again.");
      const region = clampRegion(sel, metrics);
      return await tiledCapture({ exec, windowId, tab, jobId, settings, metrics, region, mode: "region" });
    }

    // ---- full page ----
    if (settings.preScroll) {
      try { await exec(fpcPreScroll); } catch (_) {}
    }
    const metrics = await exec(fpcPrepare, [{ hideFixed: settings.hideFixed }]);
    if (!metrics) throw new Error("Could not read the page. Reload the page and try again.");
    const region = { x: 0, y: 0, w: metrics.fullW, h: metrics.fullH };
    return await tiledCapture({ exec, windowId, tab, jobId, settings, metrics, region, mode: "full" });
  } catch (e) {
    setBadge("");
    try { await exec(fpcRestore); } catch (_) {}
    return openResult(jobId, { error: (e && e.message) || "Capture failed. Please reload the page and try again." });
  } finally {
    capturingTabs.delete(tab.id);
  }
}

async function openResult(jobId, payload) {
  jobs.set(jobId, payload);
  // Drop the job if it is never claimed (e.g. the result tab was closed immediately).
  setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
  await chrome.tabs.create({ url: chrome.runtime.getURL(RESULT_PAGE) + "?job=" + jobId });
}

/* ------------------------------- Event wiring ------------------------------- */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fpc-result") return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "ready") return;
    const job = jobs.get(msg.job);
    if (!job) {
      port.postMessage({ type: "error", error: "This capture has expired. Please capture again." });
      return;
    }
    if (job.error) {
      port.postMessage({ type: "error", error: job.error });
      return;
    }
    port.postMessage({ type: "meta", meta: job.meta, count: job.tiles.length });
    let i = 0;
    const sendNext = () => {
      if (i >= job.tiles.length) {
        port.postMessage({ type: "done" });
        // Keep the job until its TTL so a manual reload of the result tab can
        // re-stream it instead of showing a false "expired" error.
        return;
      }
      const idx = i++;
      try {
        port.postMessage({ type: "tile", index: idx, tile: job.tiles[idx] });
      } catch (_) {
        return; // port closed
      }
      setTimeout(sendNext, 0);
    };
    sendNext();
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (command === "capture-full-page") runCapture(tab, "full");
  else if (command === "capture-visible") runCapture(tab, "visible");
  else if (command === "capture-area") runCapture(tab, "region");
  else if (command === "capture-element") runCapture(tab, "element");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "capture") {
    activeTab().then((tab) => runCapture(tab, msg.mode || "full", msg.delay || 0));
    sendResponse({ ok: true });
  }
  return false;
});
