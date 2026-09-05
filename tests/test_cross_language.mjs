/**
 * Python `build_signed_proxy_url` yasagan URL'ni Worker qabul qilishini tekshiradi.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import worker from '../cloudflare-worker/src/index.js';

const env = {
  PROXY_SECRET: 'shared-secret-value',
  ALLOWED_HOSTS: 'fayllar1.ru,*.fayllar1.ru',
};

const SOURCES = [
  'https://30.fayllar1.ru/30/kinolar/test.mp4',
  'https://30.fayllar1.ru/30/kinolar/Qora Ilon (Uzbek tilida).mp4',
  'https://30.fayllar1.ru/30/kinolar/Фильм 2024 [HD].mp4',
  'https://45.fayllar1.ru/x/a+b&c=d.mp4',
];

const script = `
import json, sys
sys.path.insert(0, "mtproto")
from proxy_url import build_signed_proxy_url
urls = json.loads(sys.argv[1])
print(json.dumps([
    build_signed_proxy_url("https://worker.example", u, "shared-secret-value", ttl=3600)
    for u in urls
]))
`;

const signedUrls = JSON.parse(
  execFileSync('python3', ['-c', script, JSON.stringify(SOURCES)], { encoding: 'utf8' })
);

globalThis.fetch = async () => new Response(new Uint8Array([1]), {
  status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1' },
});

let failed = 0;
for (let i = 0; i < SOURCES.length; i++) {
  const res = await worker.fetch(new Request(signedUrls[i]), env);
  try {
    assert.equal(res.status, 200, `${SOURCES[i]} -> HTTP ${res.status}`);
    console.log(`  ok  ${SOURCES[i]}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${error.message}`);
  }
}
console.log(failed ? `\n${failed} cross-language check(s) failed` : `\nall ${SOURCES.length} cross-language checks passed`);
process.exit(failed ? 1 : 0);
