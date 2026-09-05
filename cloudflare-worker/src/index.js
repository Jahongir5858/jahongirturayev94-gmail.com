const encoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function b64urlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hostAllowed(hostname, rawAllowlist) {
  const rules = String(rawAllowlist || 'fayllar1.ru,*.fayllar1.ru')
    .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  return rules.some(rule => {
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // .example.com
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === rule;
  });
}

function sanitizeHeaders(upstream, sourceUrl) {
  const out = new Headers();
  const keep = [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'etag', 'last-modified', 'content-disposition'
  ];
  for (const name of keep) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has('content-type') && sourceUrl.pathname.toLowerCase().endsWith('.mp4')) {
    out.set('content-type', 'video/mp4');
  }
  out.set('cache-control', 'no-store, no-cache, must-revalidate');
  out.set('x-content-type-options', 'nosniff');
  return out;
}

async function proxy(request, env) {
  if (!env.PROXY_SECRET) return json({ ok: false, error: 'PROXY_SECRET is not configured' }, 500);
  const reqUrl = new URL(request.url);
  const encoded = reqUrl.searchParams.get('u') || '';
  const expRaw = reqUrl.searchParams.get('e') || '';
  const nonce = reqUrl.searchParams.get('n') || '';
  const sig = (reqUrl.searchParams.get('s') || '').toLowerCase();

  if (!encoded || !expRaw || !nonce || !sig) return json({ ok: false, error: 'Missing signed URL fields' }, 400);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return json({ ok: false, error: 'Signed URL expired' }, 403);
  }
  if (exp > Math.floor(Date.now() / 1000) + 86400) {
    return json({ ok: false, error: 'Expiry too far in future' }, 403);
  }

  let source;
  try { source = new URL(b64urlDecode(encoded)); }
  catch { return json({ ok: false, error: 'Invalid source URL encoding' }, 400); }
  if (!['http:', 'https:'].includes(source.protocol)) return json({ ok: false, error: 'Unsupported scheme' }, 400);
  if (!hostAllowed(source.hostname, env.ALLOWED_HOSTS)) return json({ ok: false, error: 'Source host is not allowed' }, 403);

  const payload = `${expRaw}\n${nonce}\n${source.toString()}`;
  const expected = await hmacHex(env.PROXY_SECRET, payload);
  if (!safeEqual(expected, sig)) return json({ ok: false, error: 'Bad signature' }, 403);

  const headers = new Headers();
  const range = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  if (range) headers.set('range', range);
  if (ifRange) headers.set('if-range', ifRange);
  headers.set('user-agent', env.ORIGIN_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36');
  headers.set('accept', '*/*');
  headers.set('accept-encoding', 'identity');
  headers.set('referer', env.ORIGIN_REFERER || 'https://asilmedia.org/');

  let upstream;
  try {
    upstream = await fetch(source.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      cf: { cacheTtl: 0, cacheEverything: false },
    });
  } catch (error) {
    return json({ ok: false, error: 'Origin fetch failed', detail: String(error?.message || error) }, 502);
  }

  const responseHeaders = sanitizeHeaders(upstream, source);
  responseHeaders.set('x-proxy-origin-status', String(upstream.status));
  if (request.method === 'HEAD') return new Response(null, { status: upstream.status, headers: responseHeaders });
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function diagnosticSign(request, env) {
  if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (!env.PROXY_SECRET) return json({ ok: false, error: 'PROXY_SECRET is not configured' }, 500);
  const body = await request.json().catch(() => ({}));
  let source;
  try { source = new URL(String(body.url || '')); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }
  if (!hostAllowed(source.hostname, env.ALLOWED_HOSTS)) return json({ ok: false, error: 'Source host is not allowed' }, 403);
  const exp = Math.floor(Date.now() / 1000) + Math.min(Math.max(Number(body.ttl || 3600), 60), 86400);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const bytes = encoder.encode(source.toString());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = `${exp}\n${nonce}\n${source.toString()}`;
  const sig = await hmacHex(env.PROXY_SECRET, payload);
  const base = new URL(request.url);
  base.pathname = '/proxy';
  base.search = new URLSearchParams({ u: encoded, e: String(exp), n: nonce, s: sig }).toString();
  return json({ ok: true, proxy_url: base.toString(), expires: exp });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'telegram-mtproto-stream-proxy',
        configured: !!env.PROXY_SECRET,
        allowed_hosts: env.ALLOWED_HOSTS || 'fayllar1.ru,*.fayllar1.ru',
      });
    }
    if (url.pathname === '/proxy' && (request.method === 'GET' || request.method === 'HEAD')) {
      return proxy(request, env);
    }
    if (url.pathname === '/sign' && request.method === 'POST') {
      return diagnosticSign(request, env);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  },
};
