/* Full Page Capture — the floating "still recording" window.
 *
 * A separate little Chrome window, not something injected into the page being recorded: the
 * extension stays activeTab-only, and the page under test is left exactly as it is. The recorder
 * tab keeps the recording; this window only shows what it is doing and can ask it to stop.
 *
 * They talk over a BroadcastChannel, which works between two pages of the same extension with no
 * permission at all. If the recorder stops answering - the tab was closed, or Chrome's MP4 muxer
 * took it down - this window says so rather than sitting there with a frozen clock.
 */
const BUS = "fpc-rec";
const el = (id) => document.getElementById(id);

const bus = new BroadcastChannel(BUS);
let lastBeat = Date.now();
let stopping = false;

const pad = (n) => String(n).padStart(2, "0");
const mmss = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  return (h ? h + ":" + pad(Math.floor(t / 60) % 60) : pad(Math.floor(t / 60))) + ":" + pad(t % 60);
};
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

bus.onmessage = (e) => {
  const m = e.data || {};
  if (m.type !== "tick") return;
  lastBeat = Date.now();
  el("gone").hidden = true;
  el("clock").textContent = mmss(m.ms || 0);
  el("size").textContent = mb(m.bytes || 0);
  // Only a whole screen puts this window inside the recording; a window or a tab share does not.
  el("inShot").hidden = !(m.surface === "monitor" && !m.placed);
  if (m.state && m.state !== "recording") window.close();   // it stopped somewhere else
};

// A frozen clock is worse than no clock: say when nothing is coming.
setInterval(() => {
  if (!stopping && Date.now() - lastBeat > 4000) el("gone").hidden = false;
}, 1000);

el("stop").addEventListener("click", () => {
  stopping = true;
  el("stop").disabled = true;
  el("stop").textContent = "Stopping…";
  bus.postMessage({ type: "stop" });
  setTimeout(() => window.close(), 1200);     // the recorder tab shows the finished recording
});

el("hide").addEventListener("click", () => window.close());

// Where this window ends up is remembered by the recorder, so the person who drags it onto their
// second screen only does it once.
window.addEventListener("beforeunload", () => {
  try {
    bus.postMessage({
      type: "floatAt",
      left: window.screenX, top: window.screenY,
      width: window.outerWidth, height: window.outerHeight
    });
  } catch (_) {}
});

bus.postMessage({ type: "floatReady" });
