import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createFontHttpHandler } from '../hub-fonts.mjs';

const FACE_ID = '0123456789abcdef';

async function withServer(handlerOptions, run) {
  const handle = createFontHttpHandler(handlerOptions);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    void handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const fakeService = () => ({
  list: async () => ({ version: 1, faces: [{ id: FACE_ID, families: ['함초롬바탕'] }], hancomFaceMap: [] }),
  openFace: async (id) => {
    if (id === 'ffffffffffffffff') throw new Error(`stale: font file changed (${id})`);
    if (id !== FACE_ID) throw new Error(`unknown font id ${id}`);
    return {
      size: 5,
      async* chunks() {
        yield new Uint8Array([0, 1, 0]);
        yield new Uint8Array([0, 42]);
      },
    };
  },
});

const authenticate = (req) => {
  if (req.headers.authorization !== 'Bearer good') throw new Error('unauthorized');
};

test('serves the font index and face bytes only to an authenticated local Studio', async () => {
  await withServer({ authenticate, loadService: async () => fakeService() }, async (base) => {
    const origin = 'http://127.0.0.1:7700';
    const unauthorized = await fetch(`${base}/fonts/index`, { headers: { origin } });
    assert.equal(unauthorized.status, 401);

    const foreign = await fetch(`${base}/fonts/index`, {
      headers: { origin: 'https://evil.example', authorization: 'Bearer good' },
    });
    assert.equal(foreign.status, 403);

    const preflight = await fetch(`${base}/fonts/faces/${FACE_ID}`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/);

    const index = await fetch(`${base}/fonts/index`, { headers: { origin, authorization: 'Bearer good' } });
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual((await index.json()).faces[0].families, ['함초롬바탕']);

    const face = await fetch(`${base}/fonts/faces/${FACE_ID}`, { headers: { origin, authorization: 'Bearer good' } });
    assert.equal(face.status, 200);
    assert.deepEqual([...new Uint8Array(await face.arrayBuffer())], [0, 1, 0, 0, 42]);
  });
});

test('rejects malformed ids and reports changed files as stale', async () => {
  await withServer({ authenticate, loadService: async () => fakeService() }, async (base) => {
    const headers = { authorization: 'Bearer good' };
    assert.equal((await fetch(`${base}/fonts/faces/..%2F..%2Fetc%2Fpasswd`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/fonts/faces/aaaaaaaaaaaaaaaa`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/fonts/faces/ffffffffffffffff`, { headers })).status, 409);
  });
});

test('answers 503 when the font indexer is not available in this install', async () => {
  await withServer({
    authenticate,
    loadService: async () => { throw new Error('missing desktop/system-fonts.mjs'); },
  }, async (base) => {
    const response = await fetch(`${base}/fonts/index`, { headers: { authorization: 'Bearer good' } });
    assert.equal(response.status, 503);
  });
});


test('bounded character and glyph plans reach the authenticated font service without changing bytes', async () => {
  const calls=[];
  const service=fakeService(), open=service.openFace;
  service.openFace=async(id,options)=>{calls.push(options);return open(id);};
  await withServer({authenticate,loadService:async()=>service},async(base)=>{
    const headers={authorization:'Bearer good'}, route=`${base}/fonts/faces/${FACE_ID}`;
    const response=await fetch(`${route}?chars=41,d55c,1f600&glyphs=0,8,2a`,{headers});
    assert.equal(response.status,200);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1,0,0,42]);
    assert.deepEqual(calls,[{characters:'A한😀',glyphs:[0,8,42]}]);
    for(const query of ['chars=110000','chars=d800','chars=xyz','glyphs=1','chars=41&glyphs=fffff',`chars=${'41,'.repeat(5000)}41`]) {
      assert.equal((await fetch(`${route}?${query}`,{headers})).status,400);
    }
    assert.equal((await fetch(`${route}?chars=41`)).status,401);
    assert.equal(calls.length,1);
  });
});
