import http from 'node:http';

/** Deterministic research website: credentials and export state stay inside Chromium. */
export function researchPdf(label = 'Owned browser research reference') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = `BT /F1 20 Tf 48 720 Td (${label.replace(/[()\\]/g, '')}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export async function startResearchFixture() {
  const pdf = researchPdf();
  const requests = [];
  const timers = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const authenticated = request.headers.cookie?.split(';').some((value) => value.trim() === 'research_session=fixture-approved');
    requests.push({ method: request.method, path: url.pathname, authenticated: Boolean(authenticated) });
    const html = (body, status = 200) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(body); };
    if (url.pathname === '/login' && request.method === 'POST') {
      response.writeHead(303, { 'set-cookie': 'research_session=fixture-approved; HttpOnly; SameSite=Lax; Path=/', location: '/research' });
      response.end(); return;
    }
    if (url.pathname === '/research' && authenticated) {
      html(`<!doctype html><html lang="en"><title>Research export fixture</title><style>body{font:18px system-ui;max-width:820px;margin:48px auto;color:#16304a}button,a,input{font:inherit;margin:8px;padding:12px}h1{font-size:32px}</style><h1>Research reference exports</h1><p id="session">Approved fixture account · private paper</p><label>Research query <input aria-label="Research query" value=""></label><button id="search" onclick="document.querySelector('#result').textContent='Result: '+document.querySelector('input').value">Search references</button><p id="result"></p><a href="/pdf/get?signature=fixture-private">Download authenticated GET PDF</a><form action="/pdf/post" method="POST"><input type="hidden" name="csrf" value="fixture-export"><button>Export POST PDF</button></form><button id="blob">Download blob PDF</button><p><a href="/pdf/corrupt">Download malformed PDF</a> <a href="/pdf/slow">Download slow PDF</a> <a href="/pdf/large">Download oversized PDF</a></p><script>document.querySelector('#blob').onclick=()=>{const bytes=Uint8Array.from(atob('${pdf.toString('base64')}'),c=>c.charCodeAt(0));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));a.download='blob-reference.pdf';a.click();};</script></html>`); return;
    }
    if (url.pathname.startsWith('/pdf/')) {
      if (!authenticated) { html('<h1>Sign in required</h1>', 401); return; }
      if (url.pathname === '/pdf/post') {
        let body = ''; for await (const chunk of request) body += chunk;
        if (request.method !== 'POST' || body !== 'csrf=fixture-export') { html('<h1>Export authorization failed</h1>', 403); return; }
      }
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${url.pathname.split('/').pop()}-reference.pdf"`, 'cache-control': 'no-store' });
      if (url.pathname === '/pdf/corrupt') { response.end('%PDF-1.4\nmalformed fixture'); return; }
      if (url.pathname === '/pdf/slow' || url.pathname === '/pdf/large') {
        response.write(pdf.subarray(0, 16));
        let sent = 0;
        const timer = setInterval(() => {
          response.write(Buffer.alloc(url.pathname === '/pdf/large' ? 256 * 1024 : 32, 32));
          sent += 1;
          if (sent >= 80) { clearInterval(timer); timers.delete(timer); response.end(pdf.subarray(16)); }
        }, 100);
        timers.add(timer); response.on('close', () => { clearInterval(timer); timers.delete(timer); }); return;
      }
      response.end(pdf); return;
    }
    html('<!doctype html><html lang="en"><title>Research account fixture</title><style>body{font:20px system-ui;margin:64px;color:#16304a}button{font:inherit;padding:14px}</style><h1>Research account fixture</h1><p>This isolated test account protects PDF exports.</p><form action="/login" method="POST"><button>Sign in to fixture account</button></form></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, pdf, requests, async close() { for (const timer of timers) clearInterval(timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
