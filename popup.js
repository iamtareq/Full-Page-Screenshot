let delay = 0; // seconds to wait before a full/visible capture

const seg = document.getElementById("timerSeg");
if (seg) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-delay]");
    if (!b) return;
    delay = parseInt(b.dataset.delay, 10) || 0;
    [...seg.children].forEach((c) => c.classList.toggle("active", c === b));
  });
}

function start(mode) {
  chrome.runtime.sendMessage({ type: "capture", mode, delay }, () => {
    // Close the popup so it never appears in the screenshot and the page keeps focus.
    window.close();
  });
}

document.getElementById("full").addEventListener("click", () => start("full"));
document.getElementById("visible").addEventListener("click", () => start("visible"));
document.getElementById("region").addEventListener("click", () => start("region"));
document.getElementById("element").addEventListener("click", () => start("element"));
document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

/* ---- Update check ----------------------------------------------------------
 * Reads a public version.json from the GitHub repo and compares it to the
 * installed manifest version. GitHub raw sends CORS `*`, so this needs NO extra
 * host permission. Fails silently (offline / private repo) — update.cmd still works. */
const FPC_VERSION_URL =
  "https://raw.githubusercontent.com/iamtareq/Full-Page-Screenshot/main/version.json";

function verNewer(remote, local) {
  const a = String(remote).split("."), b = String(local).split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (parseInt(a[i], 10) || 0) - (parseInt(b[i], 10) || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// "Update now": ask the local native host to `git pull`, then reload the extension
// (reload re-reads the freshly pulled files from disk). Falls back to instructions
// if the one-time updater host isn't installed.
function runUpdate() {
  const btn = document.getElementById("updBtn");
  const how = document.getElementById("updHow");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Updating…";
  try {
    chrome.runtime.sendNativeMessage("com.fpc.updater", { action: "pull" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        btn.disabled = false;
        btn.textContent = "Update now";
        if (how) how.innerHTML = 'One-time setup: run <code>install-updater.cmd</code> in the extension folder once, then try again. (Or use <code>update.cmd</code> + Reload.)';
        return;
      }
      if (resp.ok) {
        btn.textContent = "Reloading…";
        chrome.runtime.reload();   // picks up the just-pulled files
      } else {
        btn.disabled = false;
        btn.textContent = "Retry";
        if (how) how.textContent = "Update failed: " + String(resp.output || "unknown").slice(0, 140);
      }
    });
  } catch (_) {
    btn.disabled = false;
    btn.textContent = "Update now";
    if (how) how.textContent = "Couldn't start the updater.";
  }
}

const _updBtn = document.getElementById("updBtn");
if (_updBtn) _updBtn.addEventListener("click", runUpdate);

(async function checkForUpdate() {
  try {
    const res = await fetch(FPC_VERSION_URL, { cache: "no-store" });
    if (!res.ok) return;
    const remote = ((await res.json()) || {}).version || "";
    const local = chrome.runtime.getManifest().version;
    if (remote && verNewer(remote, local)) {
      const v = document.getElementById("updVer");
      if (v) v.textContent = "(v" + remote + ")";
      const banner = document.getElementById("updateBanner");
      if (banner) banner.classList.add("show");
    }
  } catch (_) { /* offline or private repo — silent */ }
})();
