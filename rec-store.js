/* Full Page Capture — the recorder's disk writer.
 *
 * A recording used to live only in the tab's memory, so a renderer crash took the whole thing
 * with it. (It happened: Chrome 155's MP4 muxer died with MP4Status::kFailedToLookupSPS and the
 * tab went with it.) Now every chunk MediaRecorder hands over is written straight into the
 * origin's private file system and flushed, so at worst the last second is missing.
 *
 * This runs in a Worker on purpose. `createWritable()` would be simpler, but it writes to a swap
 * file and only moves it into place on close() - exactly the thing a crash prevents. A sync
 * access handle writes in place, and flush() puts the bytes on disk while the recording is still
 * going. Sync access handles are only available in a worker.
 *
 * Messages in:  {id, op:"open", name} · {id, op:"write", buf} · {id, op:"close"} · {id, op:"drop", name}
 * Messages out: {id, ok:true, at} · {id, ok:false, error}
 */
const DIR = "fpc-rec";

let handle = null;
let at = 0;

async function dir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: !!create });
}

async function open(name) {
  const d = await dir(true);
  const fh = await d.getFileHandle(name, { create: true });
  handle = await fh.createSyncAccessHandle();
  handle.truncate(0);
  at = 0;
}

function write(buf) {
  if (!handle) throw new Error("NOT_OPEN");
  at += handle.write(new Uint8Array(buf), { at });
  handle.flush();                       // the whole point of this file
  return at;
}

function close() {
  if (!handle) return at;
  try { handle.flush(); } catch (_) {}
  handle.close();
  handle = null;
  return at;
}

async function drop(name) {
  close();
  const d = await dir(false);
  await d.removeEntry(name).catch(() => {});
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    let at2 = at;
    if (m.op === "open") await open(m.name);
    else if (m.op === "write") at2 = write(m.buf);
    else if (m.op === "close") at2 = close();
    else if (m.op === "drop") await drop(m.name);
    else throw new Error("UNKNOWN_OP");
    self.postMessage({ id: m.id, ok: true, at: at2 });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
