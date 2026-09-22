const DEFAULTS = {
  format: "png",
  jpegQuality: 0.92,
  tileDelay: 130,
  preScroll: false,
  hideFixed: true,
  smoothScroll: true,
  infoBar: true,
  envBar: true,
  recentEnabled: false,          // opt-in: nothing is kept on disk until the user asks for it
  joinSuggest: true,             // the editor offers to join a page captured just before
  filenameTemplate: "{title}-{date}",
  driveClientId: "",
  driveFolderId: "",
  driveShareAnyone: false
};

const els = {
  format: document.getElementById("format"),
  jpegQuality: document.getElementById("jpegQuality"),
  tileDelay: document.getElementById("tileDelay"),
  preScroll: document.getElementById("preScroll"),
  hideFixed: document.getElementById("hideFixed"),
  smoothScroll: document.getElementById("smoothScroll"),
  infoBar: document.getElementById("infoBar"),
  envBar: document.getElementById("envBar"),
  recentEnabled: document.getElementById("recentEnabled"),
  joinSuggest: document.getElementById("joinSuggest"),
  filenameTemplate: document.getElementById("filenameTemplate"),
  driveClientId: document.getElementById("driveClientId"),
  driveFolderId: document.getElementById("driveFolderId"),
  driveShareAnyone: document.getElementById("driveShareAnyone"),
  qval: document.getElementById("qval"),
  dval: document.getElementById("dval"),
  status: document.getElementById("status")
};

// A native range draws no filled portion, so the track carries --fill and
// paints it with a gradient. Display only - no setting reads this.
function paintTrack(input) {
  if (!input) return;
  const min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
  if (!isFinite(min) || !isFinite(max) || !isFinite(v) || max === min) return;
  input.style.setProperty("--fill", String((v - min) / (max - min)));
}

function reflectEnv() {
  // The environment line is part of the URL bar; with the bar off it has
  // nothing to be part of.
  if (!els.envBar || !els.infoBar) return;
  els.envBar.disabled = !els.infoBar.checked;
  const row = els.envBar.closest(".row");
  if (row) row.style.opacity = els.infoBar.checked ? "" : ".55";
}

function reflect() {
  els.qval.textContent = Math.round(parseFloat(els.jpegQuality.value) * 100) + "%";
  els.dval.textContent = Math.round(parseFloat(els.tileDelay.value)) + " ms";
  paintTrack(els.jpegQuality);
  paintTrack(els.tileDelay);
  reflectEnv();
  fnamePreview();
}

function fnamePreview() {
  const prev = document.getElementById("fnamePreview");
  if (!prev) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let s = (els.filenameTemplate.value.trim() || DEFAULTS.filenameTemplate)
    .replace(/{title}/g, "Collection Summary Report")
    .replace(/{date}/g, date).replace(/{time}/g, time).replace(/{host}/g, "ums-5.osl.team");
  s = s.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "screenshot";
  prev.textContent = "Example: " + s + ".png";
}

async function load() {
  const s = await chrome.storage.sync.get("settings");
  const cfg = Object.assign({}, DEFAULTS, s.settings || {});
  els.format.value = cfg.format;
  els.jpegQuality.value = cfg.jpegQuality;
  els.tileDelay.value = cfg.tileDelay;
  els.preScroll.checked = cfg.preScroll;
  els.hideFixed.checked = cfg.hideFixed;
  els.smoothScroll.checked = cfg.smoothScroll;
  els.infoBar.checked = cfg.infoBar;
  els.envBar.checked = cfg.envBar;
  els.recentEnabled.checked = !!cfg.recentEnabled;
  els.joinSuggest.checked = cfg.joinSuggest !== false;
  els.filenameTemplate.value = cfg.filenameTemplate;
  els.driveClientId.value = cfg.driveClientId || "";
  els.driveFolderId.value = cfg.driveFolderId || "";
  els.driveShareAnyone.checked = !!cfg.driveShareAnyone;
  try {
    const ru = document.getElementById("redirectUri");
    if (ru && chrome.identity && chrome.identity.getRedirectURL) ru.textContent = chrome.identity.getRedirectURL();
  } catch (_) {}
  reflect();
}

// The glyph has to change too. Colour alone is the one channel a colour-blind
// user does not have, and a red checkmark still reads as "done".
function setMark(d) { const m = document.getElementById("statusMark"); if (m) m.setAttribute("d", d); }

async function save() {
  const settings = {
    format: els.format.value,
    jpegQuality: parseFloat(els.jpegQuality.value),
    tileDelay: Math.round(parseFloat(els.tileDelay.value)),
    preScroll: els.preScroll.checked,
    hideFixed: els.hideFixed.checked,
    smoothScroll: els.smoothScroll.checked,
    infoBar: els.infoBar.checked,
    envBar: els.envBar.checked,
    recentEnabled: els.recentEnabled.checked,
    joinSuggest: els.joinSuggest.checked,
    filenameTemplate: els.filenameTemplate.value.trim() || DEFAULTS.filenameTemplate,
    driveClientId: els.driveClientId.value.trim(),
    driveFolderId: els.driveFolderId.value.trim(),
    driveShareAnyone: els.driveShareAnyone.checked
  };
  // Turning the feature off should not leave captures sitting in storage.
  if (!settings.recentEnabled) {
    try { indexedDB.deleteDatabase("fpc-captures"); } catch (_) {}
  }
  // Without this a quota rejection left the page silent - no confirmation and
  // no failure, so the user could not tell the save had not happened.
  try {
    await chrome.storage.sync.set({ settings });
    els.status.classList.remove("fail");
    setMark("M5 13l4 4L19 7");           // a tick
    els.status.lastChild.textContent = "Saved";
  } catch (e) {
    els.status.classList.add("fail");
    setMark("M6 6l12 12M18 6L6 18");     // a cross, not a red tick
    els.status.lastChild.textContent = "Could not save";
  }
  els.status.classList.add("show");
  setTimeout(() => els.status.classList.remove("show"), 1800);
}

/* The redirect URI has to be pasted into Google character-perfect, so give
   it a real copy affordance instead of asking people to select it by hand. */
const copyBtn = document.getElementById("copyRedirect");
if (copyBtn) copyBtn.addEventListener("click", async () => {
  const ru = document.getElementById("redirectUri");
  const text = ru ? ru.textContent.trim() : "";
  if (!text || text === "\u2026") return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copied";
  } catch (_) {
    copyBtn.textContent = "Copy failed";
  }
  setTimeout(() => { copyBtn.textContent = "Copy"; }, 1600);
});

els.infoBar.addEventListener("change", reflectEnv);
els.jpegQuality.addEventListener("input", reflect);
els.tileDelay.addEventListener("input", reflect);
els.filenameTemplate.addEventListener("input", fnamePreview);
document.getElementById("save").addEventListener("click", save);
load();
