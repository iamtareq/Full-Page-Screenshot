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
document.getElementById("scroller").addEventListener("click", () => start("scroller"));
// Not a capture: this one opens the editor with nothing in it, ready for a file from this PC.
document.getElementById("editPic").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("result.html?open=picture") });
  window.close();
});

/* ---- "More ways to capture" ------------------------------------------------
 * Collapsed on a fresh profile, and the choice sticks. It lives in storage.local,
 * NOT in the settings object: options.js rebuilds that object from its form fields
 * on every save, so a UI preference parked there would be wiped the first time
 * someone touched Settings. */
const moreBtn = document.getElementById("moreBtn");
const moreWrap = document.getElementById("moreWrap");
const moreInner = moreWrap.firstElementChild;
let moreDone = null, moreTimer = 0;
function setMore(open, animate) {
  moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (moreDone) { moreWrap.removeEventListener("transitionend", moreDone); moreDone = null; }
  clearTimeout(moreTimer);
  moreWrap.classList.remove("settled");            // clip while it moves
  // A collapsed panel is 0px tall but its two buttons are still in the tab
  // order, so Tab used to stop twice on nothing.
  moreWrap.inert = !open;
  if (!animate) {
    moreWrap.style.transition = "none";
    moreWrap.style.height = open ? "auto" : "0px";
    if (open) moreWrap.classList.add("settled");
    requestAnimationFrame(() => requestAnimationFrame(() => { moreWrap.style.transition = ""; }));
    return;
  }
  // Both directions start from a definite pixel height, or there is nothing to animate.
  moreWrap.style.height = moreInner.offsetHeight + "px";
  if (open) {
    // Settle on transitionend, but never DEPEND on it: with prefers-reduced-motion the
    // transition is removed entirely and the event never fires, which would leave the
    // panel pinned to a stale pixel height. The timer is the guarantee.
    const settle = () => {
      if (!moreDone) return;
      clearTimeout(moreTimer);
      moreWrap.removeEventListener("transitionend", moreDone); moreDone = null;
      moreWrap.style.height = "auto";              // respect later layout changes
      moreWrap.classList.add("settled");
    };
    moreDone = (e) => { if (e.propertyName === "height") settle(); };
    moreWrap.addEventListener("transitionend", moreDone);
    moreTimer = setTimeout(settle, 260);
  } else {
    void moreWrap.offsetHeight;                    // flush the definite height first
    moreWrap.style.height = "0px";
  }
}
try {
  chrome.storage.local.get("moreOpen", (v) => setMore(!!(v && v.moreOpen), false));
} catch (_) { setMore(false, false); }
moreBtn.addEventListener("click", () => {
  const open = moreBtn.getAttribute("aria-expanded") !== "true";
  setMore(open, true);
  try { chrome.storage.local.set({ moreOpen: open }); } catch (_) {}
});

/* ---- Keyboard shortcuts -----------------------------------------------------
 * Chrome only applies a manifest `suggested_key` the first time a command is
 * registered, and it silently leaves a key unbound when another extension already
 * owns it. So never print the manifest's wishlist - ask Chrome what is actually
 * bound and show only that. Nothing bound → no chip, instead of a label that lies. */
const KBD = { "capture-full-page": "kbd-full", "capture-visible": "kbd-visible",
              "capture-area": "kbd-region", "capture-element": "kbd-element",
              "capture-scroller": "kbd-scroller", "edit-picture": "kbd-editpic" };
try {
  chrome.commands.getAll((cmds) => {
    let bound = 0;
    (cmds || []).forEach((c) => {
      const el = document.getElementById(KBD[c.name] || "");
      if (!el) return;
      if (c.shortcut) { el.textContent = c.shortcut; el.hidden = false; bound++; }
    });
    const link = document.getElementById("shortcuts");
    // Only worth offering when something is missing.
    if (link) link.hidden = bound === Object.keys(KBD).length;
  });
} catch (_) {}

const _sc = document.getElementById("shortcuts");
if (_sc) _sc.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});
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

let latestVersion = "";   // version.json on the repo, captured by the update check

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
  if (!updateConfirmed) {
    const eds = openEditors();
    if (eds.length) { showUpdateWarning(eds); return; }
  }
  updateConfirmed = false;
  btn.disabled = true;
  btn.textContent = "Updating…";
  try {
    chrome.runtime.sendNativeMessage("com.fpc.updater", { action: "pull" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        btn.disabled = false;
        btn.textContent = "Update now";
        const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "";
        if (how) {
          if (!msg || /not found/i.test(msg)) {
            // genuinely not registered yet
            how.innerHTML = 'One-time setup: run <code>install-updater.cmd</code> in the extension folder once, then try again. (Or use <code>update.cmd</code> + Reload.)';
          } else {
            // registered, but the helper could not run (execution policy, antivirus, deleted file)
            how.textContent = "The updater is installed but could not start (" + msg + "). Use update.cmd + Reload, or re-run install-updater.cmd.";
          }
        }
        return;
      }
      if (resp.ok) {
        // The host updates the folder IT lives in. If that is not the copy Chrome
        // loaded, reloading looks like a no-op and loops forever - so say so instead.
        if (latestVersion && resp.version && resp.version !== latestVersion) {
          btn.disabled = false;
          btn.textContent = "Retry";
          if (how) how.textContent = "Updated a different copy" + (resp.repo ? " (" + resp.repo + ")" : "") +
            " - Chrome seems to have loaded another folder. Load unpacked from that folder, or update it directly.";
          return;
        }
        btn.textContent = "Reloading…";
        settleEditorsThenReload();   // picks up the just-pulled files
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

/* ---- Open editors: "Update now" must not close them silently -------------------
 * chrome.runtime.reload() closes every page of this extension - every editor tab and its
 * marks with it. The popup is an extension page too, so chrome.extension.getViews hands it
 * each editor's window directly: no "tabs" permission, no roster that can go stale, and a
 * frozen (sleeping) tab still answers. A discarded tab has no page and is rightly absent. */
let updateConfirmed = false;
function openEditors() {
  let views = [];
  try { views = chrome.extension.getViews({ type: "tab" }) || []; } catch (_) {}
  const out = [];
  for (const v of views) {
    try {
      if (!/\/result\.html$/.test(v.location.pathname)) continue;
      if (typeof v.fpcEditorState !== "function") { out.push({ view: v, title: "", unknown: true }); continue; }
      const st = v.fpcEditorState();
      if (st.failed || (!st.hasImage && !st.capturing)) continue;   // error page / empty Recent picker
      out.push(Object.assign({ view: v }, st));
    } catch (_) {}
  }
  return out;
}
function describeEditors(eds) {
  const name = (e) => e.title || "Untitled capture";
  const marks = (k) => k + " unsaved mark" + (k === 1 ? "" : "s");
  const unsaved = eds.filter((e) => e.unsavedMarks);
  const fresh = eds.filter((e) => !e.unsavedMarks && e.unexported);
  const busy = eds.filter((e) => e.capturing);
  let text = eds.length + " open capture" + (eds.length === 1 ? "" : "s") + " will close.";
  if (unsaved.length === 1) text += " " + name(unsaved[0]) + " has " + marks(unsaved[0].marks) + ".";
  else if (unsaved.length > 1) text += " " + unsaved.length + " of them have unsaved marks.";
  else if (fresh.length === 1) text += " " + name(fresh[0]) + " hasn't been downloaded yet.";
  else if (fresh.length > 1) text += " " + fresh.length + " of them haven't been downloaded yet.";
  if (busy.length) text += " " + (busy.length === 1 ? "One is" : busy.length + " are") + " still capturing.";
  if (unsaved.length || fresh.length || busy.length) text += " Download them first, or update anyway.";
  const rows = eds.map((e) => ({
    title: name(e), tabId: e.tabId,
    status: e.unknown ? "open" : e.capturing ? "capturing\u2026" : e.unsavedMarks
      ? marks(e.marks) + (e.inRecent ? " \u00b7 kept in Recent" : "") : e.unexported ? "not downloaded" : "saved"
  }));
  return { text, rows };
}
function showUpdateWarning(eds) {
  const d = describeEditors(eds);
  const box = document.getElementById("updWarn");
  document.getElementById("updWarnText").textContent = d.text;
  const list = document.getElementById("updWarnList");
  list.textContent = "";
  for (const r of d.rows) {
    const li = document.createElement("li");
    const t = document.createElement("span"); t.className = "uw-title"; t.textContent = r.title;
    const st = document.createElement("span"); st.className = "uw-status"; st.textContent = r.status;
    li.appendChild(t); li.appendChild(st);
    if (r.tabId != null) {
      const go = document.createElement("button"); go.type = "button"; go.className = "uw-go"; go.textContent = "Show";
      go.addEventListener("click", () => showEditorTab(r.tabId));
      li.appendChild(go);
    }
    list.appendChild(li);
  }
  box.hidden = false;
  document.getElementById("updAnyway").focus();
}
function hideUpdateWarning() { const b = document.getElementById("updWarn"); if (b) b.hidden = true; }
// tabs.update / windows.update need no permission; Tab.windowId is never scrubbed.
function showEditorTab(tabId) {
  try {
    chrome.tabs.update(tabId, { active: true })
      .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
      .catch(() => {});
  } catch (_) {}
}
// Give each editor a moment to commit a half-typed label and write its marks to Recent.
function settleEditorsThenReload() {
  const waits = [];
  for (const e of openEditors()) {
    try { if (typeof e.view.fpcBeforeReload === "function") waits.push(e.view.fpcBeforeReload()); } catch (_) {}
  }
  let done = false;
  const go = () => { if (done) return; done = true; chrome.runtime.reload(); };
  Promise.all(waits).then(go, go);
  setTimeout(go, 1500);
}
{
  const a = document.getElementById("updAnyway"), c = document.getElementById("updCancel");
  if (a) a.addEventListener("click", () => { hideUpdateWarning(); updateConfirmed = true; runUpdate(); });
  if (c) c.addEventListener("click", hideUpdateWarning);
}

// Show the running version in the footer (handy when checking whether an update applied).
try {
  const _v = document.getElementById("verLabel");
  if (_v) _v.textContent = "v" + chrome.runtime.getManifest().version;
} catch (_) {}

const _recent = document.getElementById("recentLink");
// Recent is opt-in, so only offer it once it is switched on in Settings.
if (_recent) {
  _recent.hidden = true;
  try {
    chrome.storage.sync.get("settings", (s) => {
      const on = !!(s && s.settings && s.settings.recentEnabled);
      _recent.hidden = !on;
    });
  } catch (_) {}
}
if (_recent) _recent.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("result.html?recent=1") });
  window.close();
});

const _updBtn = document.getElementById("updBtn");
if (_updBtn) _updBtn.addEventListener("click", runUpdate);

(async function checkForUpdate() {
  try {
    const res = await fetch(FPC_VERSION_URL, { cache: "no-store" });
    if (!res.ok) return;
    const remote = ((await res.json()) || {}).version || "";
    const local = chrome.runtime.getManifest().version;
    latestVersion = remote;
    if (remote && verNewer(remote, local)) {
      const v = document.getElementById("updVer");
      if (v) v.textContent = "(v" + remote + ")";
      const banner = document.getElementById("updateBanner");
      if (banner) banner.classList.add("show");
    }
  } catch (_) { /* offline or private repo — silent */ }
})();
