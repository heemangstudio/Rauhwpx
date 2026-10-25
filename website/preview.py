"""Local website preview and generated-asset gallery, both with live reload."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import html
import json
import threading

ROOT = Path(__file__).resolve().parent
RELOAD = """<script>(()=>{let last;setInterval(async()=>{
try{const v=await(await fetch('/__dev_version',{cache:'no-store'})).text();
if(last&&v!==last)location.reload();last=v}catch{}} ,1000)})();</script>"""


def version():
    files = []
    for path in ROOT.rglob('*'):
        if any(part.startswith('.') for part in path.relative_to(ROOT).parts):
            continue
        try:
            if path.is_file():
                files.append((str(path.relative_to(ROOT)), path.stat().st_mtime_ns))
        except FileNotFoundError:
            pass  # An editor can replace a file while the preview scans it.
    return str(hash(tuple(sorted(files))))


class Site(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/__dev_version':
            return self.send(version().encode(), 'text/plain')
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / 'index.html'
        if path.suffix == '.html' and path.is_file():
            body = path.read_bytes().replace(b'</body>', RELOAD.encode() + b'</body>')
            return self.send(body, 'text/html; charset=utf-8')
        if path.suffix == '.mp4' and path.is_file() and self.headers.get('Range'):
            size = path.stat().st_size
            unit, _, span = self.headers['Range'].partition('=')
            try:
                first, last = span.split('-')
                start = int(first) if first else max(0, size - int(last))
                end = min(int(last), size - 1) if first and last else size - 1
                if unit != 'bytes' or start < 0 or start > end:
                    raise ValueError
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(end - start + 1))
            self.end_headers()
            with path.open('rb') as media:
                media.seek(start)
                self.wfile.write(media.read(end - start + 1))
            return
        super().do_GET()

    def log_message(self, *_args):
        pass


class Assets(Site):
    def do_GET(self):
        if self.path.split('?')[0] != '/':
            return super().do_GET()
        files = [ROOT / 'assets/hama.svg']
        files.extend(sorted(
            path for path in (ROOT / 'assets').glob('sketchbook-*')
            if path.is_file() and path.suffix in ('.png', '.jpg', '.webp', '.svg', '.txt')
        ))
        files.extend(sorted((ROOT / 'assets/features').glob('*.webp')))
        cards = []
        for path in files:
            src = html.escape('/' + str(path.relative_to(ROOT)))
            name = html.escape(path.name)
            if path.suffix == '.txt':
                picture = '<pre class="ascii-preview">' + html.escape(path.read_text()) + '</pre>'
            else:
                picture = f'<img src="{src}" alt="{name}">'
            cards.append(f'''<article><a href="{src}">{picture}</a>
<h2>{name}</h2><p>{round(path.stat().st_size / 1024)} KB</p>
<a href="{src}" download>Download asset</a></article>''')
        prompts = []
        for path in sorted((ROOT / 'assets').glob('sketchbook-*.json')):
            metadata = json.loads(path.read_text())
            prompt = html.escape(metadata['prompt'])
            name = html.escape(path.stem)
            prompts.append(f'<details><summary>{name} generation prompt</summary><p>{metadata["tool"]}</p><pre>{prompt}</pre><a href="/assets/{path.name}">Generation metadata</a></details>')
        body = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HamaEditor asset gallery</title><style>
body{{font:16px/1.5 system-ui;margin:32px;background:#16191b;color:#e9e9e0}}
h1{{font-size:32px}} main{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px}}
article{{padding:24px;background:#222a2e;border-radius:8px;min-width:0}}
img{{width:100%;height:300px;object-fit:contain;background:#1b1f22}}
h2{{font-size:18px;overflow-wrap:anywhere}} a{{color:#a0bdf6}}
pre{{white-space:pre-wrap;font:inherit;max-width:75ch}} details{{margin-bottom:24px}}
.ascii-preview{{display:grid;place-content:center;height:300px;max-width:none;margin:0;overflow:clip;white-space:pre;font:3.5px/1 monospace;color:#deded1;background:#1b1f22}}
</style></head><body><h1>HamaEditor asset gallery</h1>
<p>Paper textures, large ASCII sculptures, and the existing pixel-art hippo. Updates automatically.</p>
<p><a href="http://127.0.0.1:7716">Open live website</a></p>
{''.join(prompts)}
<main>{''.join(cards)}</main>{RELOAD}</body></html>'''
        self.send(body.encode(), 'text/html; charset=utf-8')


if __name__ == '__main__':
    for port, handler in [(7716, Site), (7717, Assets)]:
        server = ThreadingHTTPServer(('127.0.0.1', port), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f'http://127.0.0.1:{port}', flush=True)
    threading.Event().wait()
