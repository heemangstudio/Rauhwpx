export function koreanCidPdf(text, encoding = 'UniKS-UCS2-H') {
  const hex = [...text].map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0')).join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    `<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /${encoding} /DescendantFonts [5 0 R] >>`,
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R /DW 1000 >>',
    null,
    '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -148 1001 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 60 >>',
  ];
  const stream = `BT /F1 24 Tf 72 720 Td <${hex}> Tj ET`;
  objects[5] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
