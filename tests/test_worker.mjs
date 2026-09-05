import assert from 'node:assert/strict';
import worker from '../cloudflare-worker/src/index.js';

const env = {
  PROXY_SECRET: 'secret',
  ADMIN_KEY: 'admin-key-0123456789',
  ALLOWED_HOSTS: 'fayllar1.ru,*.fayllar1.ru',
  ORIGIN_REFERER: 'https://asilmedia.org/',
};

const realFetch = globalThis.fetch;
let originCalls = [];

function mockOrigin(handler) {
  originCalls = [];
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

async function signUrl(sourceUrl) {
  const res = await worker.fetch(new Request('https://worker.example/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
    body: JSON.stringify({ url: sourceUrl, ttl: 3600 }),
  }), env);
  assert.equal(res.status, 200, 'sign endpoint should succeed');
  return (await res.json()).proxy_url;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('health reports parsed allowlist', async () => {
  const res = await worker.fetch(new Request('https://worker.example/health'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.allowed_hosts, ['fayllar1.ru', '*.fayllar1.ru']);
});

test('sign requires the admin key', async () => {
  const res = await worker.fetch(new Request('https://worker.example/sign', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://30.fayllar1.ru/a.mp4' }),
  }), env);
  assert.equal(res.status, 401);
});

test('signed URL with spaces and parentheses verifies', async () => {
  const source = 'https://30.fayllar1.ru/30/kinolar/Qora Ilon (Uzbek tilida).mp4';
  const proxyUrl = await signUrl(source);
  mockOrigin(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 206,
    headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/4096', 'accept-ranges': 'bytes' },
  }));
  const res = await worker.fetch(new Request(proxyUrl, { headers: { range: 'bytes=0-1023' } }), env);
  assert.equal(res.status, 206, await res.text());
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.match(res.headers.get('content-disposition') || '', /Qora Ilon/);
  assert.equal(originCalls[0].url,
    'https://30.fayllar1.ru/30/kinolar/Qora%20Ilon%20(Uzbek%20tilida).mp4');
});

test('tampered signature is rejected', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  const broken = proxyUrl.replace(/s=([0-9a-f])/, (m, c) => `s=${c === 'a' ? 'b' : 'a'}`);
  const res = await worker.fetch(new Request(broken), env);
  assert.equal(res.status, 403);
});

test('host outside the allowlist is rejected', async () => {
  const res = await worker.fetch(new Request('https://worker.example/sign', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
    body: JSON.stringify({ url: 'https://evil.example/a.mp4' }),
  }), env);
  assert.equal(res.status, 403);
});

test('redirect to a non-allowlisted host is refused', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  mockOrigin(async () => new Response(null, {
    status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' },
  }));
  const res = await worker.fetch(new Request(proxyUrl), env);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /not allowed/);
});

test('redirect inside the allowlist is followed', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  let hop = 0;
  mockOrigin(async () => {
    hop += 1;
    if (hop === 1) {
      return new Response(null, { status: 302, headers: { location: 'https://45.fayllar1.ru/x.mp4' } });
    }
    return new Response(new Uint8Array([9]), {
      status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1' },
    });
  });
  const res = await worker.fetch(new Request(proxyUrl), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-proxy-redirects'), '1');
});

test('redirect loops are bounded', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  mockOrigin(async () => new Response(null, {
    status: 302, headers: { location: 'https://30.fayllar1.ru/loop.mp4' },
  }));
  const res = await worker.fetch(new Request(proxyUrl), env);
  assert.equal(res.status, 508);
});

test('HEAD is served through a ranged GET and reports total size', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  mockOrigin(async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('range'), 'bytes=0-0');
    return new Response(new Uint8Array([1]), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/2147483648' },
    });
  });
  const res = await worker.fetch(new Request(proxyUrl, { method: 'HEAD' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '2147483648');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), null);
});

test('origin request carries referer and identity encoding', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  mockOrigin(async (url, init) => {
    assert.equal(init.headers.get('referer'), 'https://asilmedia.org/');
    assert.equal(init.headers.get('accept-encoding'), 'identity');
    return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-length': '1' } });
  });
  const res = await worker.fetch(new Request(proxyUrl), env);
  assert.equal(res.status, 200);
});

test('mp4 content-type is inferred when origin omits it', async () => {
  const proxyUrl = await signUrl('https://30.fayllar1.ru/30/kinolar/test.mp4');
  mockOrigin(async () => new Response(new Uint8Array([1]), { status: 200 }));
  const res = await worker.fetch(new Request(proxyUrl), env);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
});

test('unknown routes return 404', async () => {
  const res = await worker.fetch(new Request('https://worker.example/nope'), env);
  assert.equal(res.status, 404);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} worker tests passed`);
process.exit(failed ? 1 : 0);
