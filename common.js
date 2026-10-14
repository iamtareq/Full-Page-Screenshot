/* Full Page Capture — helpers shared by the editor and the recorder.
 *
 * Loaded before the page script, as a classic script: everything here lands in the same
 * global scope the page script runs in. Moved out of result.js unchanged (v1.6.0), except
 * for saveBlob's holdMs.
 */

function sanitize(name, max = 80) {
  return (name || "screenshot").replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "screenshot";
}
function pad(n) { return String(n).padStart(2, "0"); }

// holdMs: how long the object URL must stay alive. chrome.downloads keeps reading from it
// while it writes, and a big file can still be writing long after a screenshot would be done.
async function saveBlob(blob, filename, holdMs) {
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
    setTimeout(() => URL.revokeObjectURL(url), holdMs || 60000);
  }
}
