# Full Page Capture — Screenshot

A powerful, privacy-friendly Chrome/Edge extension (Manifest V3) that captures a
**full-page screenshot** of any web page — the entire scrollable page, not just the
visible part — and lets you export it as **PNG, JPG, or PDF**, copy it to the clipboard,
crop it, or print it.

A clean, self-contained alternative to "GoFullPage".

## Features

- **Full-page capture** — scrolls the whole page and stitches every section into one image.
- **Visible-area capture** — grab just what's on screen.
- **Area capture** — drag a selection box over the page and capture just that region (`Alt+Shift+A`). Drag to the viewport edge to auto-scroll, so you can select an area taller/wider than the screen; it's stitched via the tiling engine.
- **Handles the hard cases**
  - Respects Chrome's `captureVisibleTab` rate limit (spacing + retry/backoff) so tall pages don't fail.
  - Hides sticky/fixed headers, footers and cookie bars so they don't repeat down the image.
  - Optional pre-scroll to trigger lazy-loaded images.
  - Correct handling of High-DPI (Retina / Windows scaling) screens.
  - Splits gigantic pages into multiple parts automatically (stays within the browser's canvas limits).
- **Editor page** — preview with zoom, one-click download, format switcher, quality slider, crop tool, copy, print.
- **Annotate (for bug reports)** — draw **boxes** (red by default), **ellipses**, **arrows**, **lines**, **free-hand pen**, **highlighter**, **text labels**, and **blur/redact** to hide sensitive info. 7 colours, adjustable size, undo/redo (Ctrl+Z / Ctrl+Y), clear. Annotations are non-destructive and are baked into every export (PNG/JPG/PDF/copy/print).
- **Export**: PNG (lossless), JPG (quality slider), multi-page PDF.
- **Send to Google Drive** — one click uploads the screenshot to your pre-set Drive folder and copies the shareable link to your clipboard (great for bug reports). Requires a one-time OAuth setup (below).

## Google Drive setup (one time)

To let the extension upload to **your** Drive, create your own OAuth client:

1. [console.cloud.google.com](https://console.cloud.google.com) → create/select a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → configure (User type: External; add your Google account under **Test users**).
4. **Credentials → Create Credentials → OAuth client ID → Web application**.
5. Under **Authorized redirect URIs**, add the exact URI shown on the extension's **Settings** page (looks like `https://<id>.chromiumapp.org/`).
6. Copy the **Client ID** → paste into the extension **Settings → OAuth Client ID**. Paste your target Drive **folder** URL/ID too. Save.
7. In the editor, click **Send to Drive** → approve access once (Google shows an "unverified app" screen for your own testing app → **Advanced → Go to app**) → the file uploads and the link is copied.

**Privacy notes:** uses the Drive scope so it can drop files into *your chosen folder* (the per-file scope can't write to a folder the app didn't create). Uploads are **private by default** — share your target folder with your dev/team once and the links just work. Only turn on **"Make links public"** in Settings if you send links to people outside the folder (screenshots can contain sensitive data).
- **Keyboard shortcuts**: `Alt+Shift+P` (full page), `Alt+Shift+V` (visible area), `Alt+Shift+A` (select area).
- **Settings**: default format, quality, render delay, pre-scroll, hide-fixed, file-name template.
- **Privacy**: uses the `activeTab` permission only — it can see a page **only when you click the button
  or press the shortcut**. No `<all_urls>`, no host permissions, nothing leaves your machine.

## Install (Load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `full-page-capture` folder.
4. Pin the extension. Open any normal web page and click the icon → **Capture full page**.

To change the keyboard shortcuts: `chrome://extensions/shortcuts`.

## How it works

```
popup / shortcut ─▶ background.js
                       │  chrome.scripting → scroll the page section by section
                       │  chrome.tabs.captureVisibleTab → one PNG per section
                       ▼
                    result.html  ── stitches the tiles onto a canvas ──▶ PNG / JPG / PDF
```

All image work happens in `result.html` (a normal page), so the service worker only shuttles
data — no service-worker canvas/blob limitations.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, commands |
| `background.js` | Capture orchestration + rate-limit handling |
| `popup.html/js` | Toolbar popup (full / visible / settings) |
| `result.html/css/js` | Stitching + editor + export |
| `lib/pdf.js` | Tiny dependency-free JPEG→PDF writer |
| `options.html/js` | Settings page |
| `icons/` | Extension icons |

## Known limitations

- Cannot capture browser system pages (`chrome://`, the Web Store, other extensions' pages) — the
  browser blocks **all** extensions there.
- Pages that scroll inside an inner element (rather than the window) may only capture the window view.
- A fixed footer is kept only in the first section (to avoid it repeating), so it appears once near the top.
- Crop is available for single-part images (very large split images are exported per part or as a multi-page PDF).

## License

MIT — do whatever you like.
