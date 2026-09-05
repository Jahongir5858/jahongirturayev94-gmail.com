import worker from '../cloudflare-worker/src/index.js';
import { createHmac } from 'node:crypto';

const env = {
  PROXY_SECRET: 'secret',
  ADMIN_KEY: 'admin',
  ALLOWED_HOSTS: 'fayllar1.ru,*.fayllar1.ru',
  ORIGIN_REFERER: 'https://asilmedia.org/'
};

const health = await worker.fetch(new Request('https://worker.example/health'), env);
if (health.status !== 200) throw new Error('health failed');

const signReq = new Request('https://worker.example/sign', {
  method: 'POST',
  headers: {'content-type':'application/json','x-admin-key':'admin'},
  body: JSON.stringify({url:'https://30.fayllar1.ru/30/kinolar/test.mp4', ttl:3600})
});
const signed = await worker.fetch(signReq, env);
if (signed.status !== 200) throw new Error('sign failed');
const body = await signed.json();
if (!body.proxy_url) throw new Error('proxy url missing');

globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://30.fayllar1.ru/')) throw new Error('unexpected origin');
  const headers = new Headers({
    'content-type':'video/mp4',
    'content-length':'1024',
    'accept-ranges':'bytes',
    'content-range':'bytes 0-1023/1024'
  });
  return new Response(new Uint8Array([1,2,3,4]), {status:206, headers});
};

const proxied = await worker.fetch(new Request(body.proxy_url, {headers:{range:'bytes=0-1023'}}), env);
if (proxied.status !== 206) throw new Error(`proxy status ${proxied.status}`);
if (proxied.headers.get('content-type') !== 'video/mp4') throw new Error('content type missing');
if (proxied.headers.get('accept-ranges') !== 'bytes') throw new Error('range header missing');
const bytes = new Uint8Array(await proxied.arrayBuffer());
if (bytes.length !== 4) throw new Error('stream body mismatch');

console.log('worker tests passed');
