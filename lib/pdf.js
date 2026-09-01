/* Minimal, dependency-free PDF writer.
 * Builds a (multi-page) PDF where each page is a single embedded JPEG (DCTDecode).
 * images: [{ jpeg: Uint8Array, width, height, link? }]
 *   link (optional): { uri: string, rect: [x0, y0, x1, y1] } in PDF coords (bottom-up,
 *   1 unit = 1 image pixel) — renders a clickable URL annotation on that page.
 * Returns a Uint8Array ready to wrap in a Blob({type:'application/pdf'}).
 */
(function () {
  function escapeStr(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[\r\n]/g, "");
  }

  function build(images) {
    const enc = new TextEncoder();
    const chunks = [];
    let length = 0;
    const push = (bytes) => { chunks.push(bytes); length += bytes.length; };
    const str = (s) => push(enc.encode(s));

    const offsets = [];            // offsets[objNum] = byte offset
    let nextObj = 1;
    const alloc = () => nextObj++;
    const begin = (num) => { offsets[num] = length; str(num + " 0 obj\n"); };
    const end = () => str("endobj\n");

    const catalogNum = alloc();    // 1
    const pagesNum = alloc();      // 2

    // Allocate object numbers up front (so /Kids and refs are known).
    const plan = images.map((img) => ({
      img,
      pageNum: alloc(),
      contentNum: alloc(),
      imgNum: alloc(),
      linkNum: img.link ? alloc() : 0
    }));

    str("%PDF-1.4\n");
    str("%âãÏÓ\n"); // binary marker

    begin(catalogNum);
    str("<< /Type /Catalog /Pages " + pagesNum + " 0 R >>\n");
    end();

    begin(pagesNum);
    str("<< /Type /Pages /Count " + images.length +
        " /Kids [" + plan.map((p) => p.pageNum + " 0 R").join(" ") + "] >>\n");
    end();

    for (const p of plan) {
      const W = p.img.width, H = p.img.height;

      // Page
      begin(p.pageNum);
      let pg = "<< /Type /Page /Parent " + pagesNum + " 0 R /MediaBox [0 0 " + W + " " + H + "] " +
               "/Resources << /XObject << /Im0 " + p.imgNum + " 0 R >> >> " +
               "/Contents " + p.contentNum + " 0 R";
      if (p.linkNum) pg += " /Annots [" + p.linkNum + " 0 R]";
      pg += " >>\n";
      str(pg);
      end();

      // Content stream: draw the image over the whole page.
      const content = "q\n" + W + " 0 0 " + H + " 0 0 cm\n/Im0 Do\nQ\n";
      const contentBytes = enc.encode(content);
      begin(p.contentNum);
      str("<< /Length " + contentBytes.length + " >>\nstream\n");
      push(contentBytes);
      str("\nendstream\n");
      end();

      // Image XObject
      begin(p.imgNum);
      str("<< /Type /XObject /Subtype /Image /Width " + W + " /Height " + H +
          " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
          p.img.jpeg.length + " >>\nstream\n");
      push(p.img.jpeg);
      str("\nendstream\n");
      end();

      // Clickable URL link annotation
      if (p.linkNum) {
        const r = p.img.link.rect;
        begin(p.linkNum);
        str("<< /Type /Annot /Subtype /Link /Rect [" +
            r[0] + " " + r[1] + " " + r[2] + " " + r[3] + "] " +
            "/Border [0 0 0] /H /I " +
            "/A << /Type /Action /S /URI /URI (" + escapeStr(p.img.link.uri) + ") >> >>\n");
        end();
      }
    }

    const totalObjects = nextObj - 1;
    const xrefOffset = length;
    str("xref\n");
    str("0 " + (totalObjects + 1) + "\n");
    str("0000000000 65535 f \n");
    for (let i = 1; i <= totalObjects; i++) {
      str(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
    }
    str("trailer\n<< /Size " + (totalObjects + 1) + " /Root " + catalogNum + " 0 R >>\n");
    str("startxref\n" + xrefOffset + "\n%%EOF");

    const out = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  self.FPCPDF = { build };
})();
