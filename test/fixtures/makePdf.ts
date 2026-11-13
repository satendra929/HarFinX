// Builds a small, valid, text-only PDF for tests (standard Helvetica, absolute text positions). ASCII text only.
export interface Run {
  x: number;
  y: number;
  text: string;
  size?: number;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** `pages[i]` lists the text runs of page i + 1 (an empty list gives a page with no text). */
export function makePdf(pages: Run[][]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + 2 * i);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((runs, i) => {
    const content = runs.map((r) => `BT /F1 ${r.size ?? 10} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${esc(r.text)}) Tj ET`).join("\n");
    objects[4 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[5 + 2 * i] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
