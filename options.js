const DEFAULTS = {
  format: "png",
  jpegQuality: 0.92,
  tileDelay: 130,
  preScroll: false,
  hideFixed: true,
  smoothScroll: true,
  infoBar: true,
  envBar: true,
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
  filenameTemplate: document.getElementById("filenameTemplate"),
  driveClientId: document.getElementById("driveClientId"),
  driveFolderId: document.getElementById("driveFolderId"),
  driveShareAnyone: document.getElementById("driveShareAnyone"),
  qval: document.getElementById("qval"),
  dval: document.getElementById("dval"),
  status: document.getElementById("status")
};

function reflect() {
  els.qval.textContent = Math.round(parseFloat(els.jpegQuality.value) * 100) + "%";
  els.dval.textContent = Math.round(parseFloat(els.tileDelay.value)) + " ms";
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
    filenameTemplate: els.filenameTemplate.value.trim() || DEFAULTS.filenameTemplate,
    driveClientId: els.driveClientId.value.trim(),
    driveFolderId: els.driveFolderId.value.trim(),
    driveShareAnyone: els.driveShareAnyone.checked
  };
  await chrome.storage.sync.set({ settings });
  els.status.classList.add("show");
  setTimeout(() => els.status.classList.remove("show"), 1400);
}

els.jpegQuality.addEventListener("input", reflect);
els.tileDelay.addEventListener("input", reflect);
els.filenameTemplate.addEventListener("input", fnamePreview);
document.getElementById("save").addEventListener("click", save);
load();
