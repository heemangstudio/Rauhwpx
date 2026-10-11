/**
 * 쪽마다 글이 있거나 없는 작은 PDF. pages 의 각 값이 문자열이면 그 글을 Helvetica 로 찍고,
 * null 이면 내용 스트림이 없는 빈 쪽(스캔 쪽처럼 글자 층이 없다)이다.
 * @param {(string|null)[]} pages
 */
export function pagedPdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const kids = [];
  for (const text of pages) {
    const pageNumber = objects.length + 1;
    kids.push(`${pageNumber} 0 R`);
    if (typeof text === 'string') {
      const escaped = text.replace(/[\\()]/g, (ch) => `\\${ch}`);
      const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`);
      objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    } else {
      objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >>');
    }
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
