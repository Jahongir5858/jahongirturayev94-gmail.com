const encoder = new TextEncoder();

const DEFAULT_ALLOWED_HOSTS = 'fayllar1.ru,*.fayllar1.ru';
const MAX_REDIRECTS = 5;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
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

function b64urlEncode(text) {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseAllowlist(rawAllowlist) {
  return String(rawAllowlist || DEFAULT_ALLOWED_HOSTS)
    .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(hostname, rawAllowlist) {
  const rules = parseAllowlist(rawAllowlist);
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return rules.some(rule => {
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === rule;
  });
}

function originHeaders(env, { range, ifRange } = {}) {
  const headers = new Headers();
  if (range) headers.set('range', range);
  if (ifRange) headers.set('if-range', ifRange);
  headers.set('user-agent', env.ORIGIN_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36');
  headers.set('accept', '*/*');
  headers.set('accept-encoding', 'identity');
  if (env.ORIGIN_REFERER) headers.set('referer', env.ORIGIN_REFERER);
  return headers;
}

async function fetchFollowingAllowlist(startUrl, method, headers, env) {
  let current = new URL(startUrl.toString());
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!hostAllowed(current.hostname, env.ALLOWED_HOSTS)) {
      return { error: `Redirect target host is not allowed: ${current.hostname}`, status: 403, chain };
    }
    const response = await fetch(current.toString(), {
      method,
      headers,
      redirect: 'manual',
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location');
    if (!isRedirect) {
      return { response, finalUrl: current, chain };
    }

    if (response.body) await response.body.cancel().catch(() => {});
    let next;
    try {
      next = new URL(response.headers.get('location'), current);
    } catch {
      return { error: 'Origin returned an unparsable Location header', status: 502, chain };
    }
    if (!['http:', 'https:'].includes(next.protocol)) {
      return { error: `Unsupported redirect scheme: ${next.protocol}`, status: 403, chain };
    }
    chain.push(next.hostname);
    current = next;
  }
  return { error: 'Too many redirects', status: 508, chain };
}

function sourceFilename(sourceUrl) {
  let name = sourceUrl.pathname.split('/').pop() || 'video.mp4';
  try { name = decodeURIComponent(name); } catch {}
  name = name.replace(/[\r\n\0]/g, '').trim() || 'video.mp4';
  return name;
}

function contentDispositionFilename(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/'/g, '%27');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sanitizeHeaders(upstream, sourceUrl) {
  const out = new Headers();
  const keep = [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'etag', 'last-modified', 'content-disposition',
  ];
  for (const name of keep) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has('content-type') && sourceUrl.pathname.toLowerCase().endsWith('.mp4')) {
    out.set('content-type', 'video/mp4');
  }
  if (!out.has('content-disposition')) {
    out.set('content-disposition', contentDispositionFilename(sourceFilename(sourceUrl)));
  }
  if (!out.has('accept-ranges') && out.has('content-range')) out.set('accept-ranges', 'bytes');
  out.set('cache-control', 'no-store, no-cache, must-revalidate');
  out.set('x-content-type-options', 'nosniff');
  return out;
}

function totalSizeFromContentRange(value) {
  const match = /\/(\d+)\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function verifySignedRequest(reqUrl, env) {
  const token = reqUrl.searchParams.get('u') || '';
  const expRaw = reqUrl.searchParams.get('e') || '';
  const nonce = reqUrl.searchParams.get('n') || '';
  const sig = (reqUrl.searchParams.get('s') || '').toLowerCase();

  if (!token || !expRaw || !nonce || !sig) {
    return { error: 'Missing signed URL fields', status: 400 };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { error: 'Invalid expiry', status: 400 };
  if (exp < now) return { error: 'Signed URL expired', status: 403 };
  if (exp > now + 86400) return { error: 'Expiry too far in future', status: 403 };

  let source;
  try {
    source = new URL(b64urlDecode(token));
  } catch {
    return { error: 'Invalid source URL encoding', status: 400 };
  }
  if (!['http:', 'https:'].includes(source.protocol)) {
    return { error: 'Unsupported scheme', status: 400 };
  }
  if (!hostAllowed(source.hostname, env.ALLOWED_HOSTS)) {
    return { error: 'Source host is not allowed', status: 403 };
  }
  return { token, expRaw, nonce, sig, source };
}

async function proxy(request, env) {
  if (!env.PROXY_SECRET) return json({ ok: false, error: 'PROXY_SECRET is not configured' }, 500);

  const parsed = verifySignedRequest(new URL(request.url), env);
  if (parsed.error) return json({ ok: false, error: parsed.error }, parsed.status);

  const payload = `${parsed.expRaw}\n${parsed.nonce}\n${parsed.token}`;
  const expected = await hmacHex(env.PROXY_SECRET, payload);
  if (!safeEqualHex(expected, parsed.sig)) return json({ ok: false, error: 'Bad signature' }, 403);

  const isHead = request.method === 'HEAD';
  const headers = originHeaders(env, {
    range: isHead ? 'bytes=0-0' : request.headers.get('range'),
    ifRange: isHead ? null : request.headers.get('if-range'),
  });

  let result;
  try {
    result = await fetchFollowingAllowlist(parsed.source, 'GET', headers, env);
  } catch (error) {
    return json({ ok: false, error: 'Origin fetch failed', detail: String(error?.message || error) }, 502);
  }
  if (result.error) return json({ ok: false, error: result.error, chain: result.chain }, result.status);

  const upstream = result.response;

  if (isHead) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    const responseHeaders = sanitizeHeaders(upstream, parsed.source);
    const total = totalSizeFromContentRange(upstream.headers.get('content-range'));
    responseHeaders.delete('content-range');
    if (total !== null) {
      responseHeaders.set('content-length', String(total));
      responseHeaders.set('accept-ranges', 'bytes');
    }
    responseHeaders.set('x-proxy-origin-status', String(upstream.status));
    if (result.chain.length) responseHeaders.set('x-proxy-redirects', String(result.chain.length));
    const status = upstream.status === 206 ? 200 : upstream.status;
    return new Response(null, { status, headers: responseHeaders });
  }

  const responseHeaders = sanitizeHeaders(upstream, parsed.source);
  responseHeaders.set('x-proxy-origin-status', String(upstream.status));
  if (result.chain.length) responseHeaders.set('x-proxy-redirects', String(result.chain.length));
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function diagnosticSign(request, env) {
  if (!env.ADMIN_KEY || !safeEqualHex(request.headers.get('x-admin-key') || '', env.ADMIN_KEY)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (!env.PROXY_SECRET) return json({ ok: false, error: 'PROXY_SECRET is not configured' }, 500);

  const body = await request.json().catch(() => ({}));
  const rawUrl = String(body.url || '');
  let source;
  try { source = new URL(rawUrl); }
  catch { return json({ ok: false, error: 'Invalid URL' }, 400); }
  if (!hostAllowed(source.hostname, env.ALLOWED_HOSTS)) {
    return json({ ok: false, error: 'Source host is not allowed' }, 403);
  }

  const ttl = Math.min(Math.max(Number(body.ttl || 3600), 60), 86400);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const token = b64urlEncode(rawUrl);
  const sig = await hmacHex(env.PROXY_SECRET, `${exp}\n${nonce}\n${token}`);

  const base = new URL(request.url);
  base.pathname = `/proxy/${encodeURIComponent(sourceFilename(source))}`;
  base.search = new URLSearchParams({ u: token, e: String(exp), n: nonce, s: sig }).toString();
  return json({ ok: true, proxy_url: base.toString(), expires: exp });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        ok: true,
        service: 'telegram-mtproto-stream-proxy',
        configured: Boolean(env.PROXY_SECRET),
        allowed_hosts: parseAllowlist(env.ALLOWED_HOSTS),
        max_redirects: MAX_REDIRECTS,
      });
    }
    if ((url.pathname === '/proxy' || url.pathname.startsWith('/proxy/')) && (request.method === 'GET' || request.method === 'HEAD')) {
      return proxy(request, env);
    }
    if (url.pathname === '/sign' && request.method === 'POST') {
      return diagnosticSign(request, env);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  },
};
