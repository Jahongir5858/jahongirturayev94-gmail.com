# Telegram MTProto uploader — v3 corrected

Katta videoni Telegram kanalga joylash uchun **external-first + streaming fallback** uploader.

## Eng muhim tuzatish

Oldingi v2 README `InputMediaDocumentExternal` uchun 20 MB limitni qat'iy deb yozgan edi. Bu isbotlanmagan.
Telegram'ning **Bot API** hujjatida HTTP URL bilan yuborish uchun 20 MB limit bor, lekin MTProto
`inputMediaDocumentExternal` rasmiy sahifasi faqat “Telegram serverlari URL'dan hujjatni yuklaydi” deydi va
20 MB limit ko'rsatmaydi.

Shuning uchun v3 default `auto` rejimida:

1. avval `InputMediaDocumentExternal` sinanadi — runner video baytlarini tashimaydi;
2. faqat Telegram external-fetch'ga xos xato (`WEBPAGE_CURL_FAILED`, `WEBPAGE_MEDIA_EMPTY`, va h.k.) qaytarsa
   `stream` fallback ishlaydi;
3. chat/peer/permission xatolari fallback bilan yashirilmaydi, darhol xato sifatida qaytadi.

Agar external'ni faqat ma'lum hajmgacha sinashni xohlasangiz, GitHub variable `EXTERNAL_MAX_BYTES` ni >0 qiling.
Default `0` — hajm bo'yicha cap yo'q.

## Oqim

### 1) External — birinchi tanlov

`fayllar1.ru -> Cloudflare signed proxy -> Telegram server -> kanal`

GitHub runner faqat MTProto RPC yuboradi. Katta video baytlari runner orqali o'tmaydi.

### 2) Stream fallback

`fayllar1.ru -> GitHub runner -> MTProto upload.saveBigFilePart -> Telegram`

Diskka to'liq video yozilmaydi; baytlar chunk-chunk uzatiladi. Direct origin GitHub runner'ni bloklasa,
keyingi retry `Cloudflare proxy -> runner -> Telegram` ga o'tadi.

Telegram'ning joriy client config hujjatida upload limitlari 4000/8000 ta 512 KiB part orqali belgilanadi
(non-Premium/Premium). Bu limitlar server konfiguratsiyasi bo'lgani uchun kodda “abadiy 2/4 GB” deb hardcode qilinmagan.

## v2 dan topilgan va v3 da tuzatilgan xatolar

1. **Noto'g'ri 20 MB xulosasi** — Bot API limiti MTProto external media uchun hujjatlashtirilgan limit emas.
2. **Probe butun videoni yuklab yuborishi mumkin edi** — origin Range'ni e'tiborsiz qoldirib HTTP 200 qaytarsa,
   `await resp.content.read()` qolgan multi-GB body'ni drain qilardi. Endi 1024 baytdan keyin response yopiladi.
3. **`EXTERNAL_MAX_BYTES` bo'sh GitHub variable bo'lsa crash** — `int("")` muammosi tuzatildi; bo'sh qiymat defaultga tushadi.
4. **Auto fallback juda keng edi** — har qanday `RPCError` stream'ga o'tardi. Endi faqat external-fetch xatolari fallback qiladi.
5. **Direct stream hotlink headerlarsiz edi** — User-Agent va Referer qo'shildi; direct stream bloklansa proxy-stream fallback bor.
6. **Probe va real stream hajmi farqi** — upload boshlanishida Content-Length/Content-Range mosligi tekshiriladi.
7. **Temp thumbnail qolib ketardi** — yuborilgach o'chiriladi.
8. **Repo default branch `master`, workflow esa faqat `main` edi** — deploy endi `master` va `main` uchun ishlaydi.
9. **Proxy URL `.mp4` bilan tugamasdi** — Telegram tashqi hujjatni `proxy` nomi bilan ko'rishi mumkin edi. Endi signed URL
   `/proxy/<original-filename>.mp4?...` ko'rinishida va Worker `Content-Disposition` filename ham beradi.
10. v2 dagi yaxshi tuzatishlar saqlandi: opaque-token HMAC, redirect allowlist, SSRF himoyasi, Range/HEAD emulyatsiyasi,
    Worker/cross-language testlar.

## Cloudflare secrets

- `PROXY_SECRET` — uzun tasodifiy secret.
- `ADMIN_KEY` — ixtiyoriy, `/sign` diagnostik endpointi uchun.

## GitHub Actions secrets

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELETHON_SESSION`
- `TELEGRAM_CHANNEL` — imkon bo'lsa `@username`
- `TELEGRAM_CHANNEL_ACCESS_HASH` — numeric kanal ID ishlatilsa
- `CF_PROXY_BASE`
- `CF_PROXY_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CF_ADMIN_KEY` — ixtiyoriy

## GitHub Actions variables

- `EXTERNAL_MAX_BYTES` — default `0` (external-first, cap yo'q).
- `STREAM_VIA_PROXY=true` — stream boshidan Cloudflare orqali o'tsin; default direct origin.

## Test tartibi

1. `MTProto upload` workflow: `mode=auto`, `dry_run=true`.
2. Kichik, tarqatish huquqi sizda bo'lgan MP4 bilan `dry_run=false`.
3. Keyin katta fayl bilan `mode=auto` — external ishlasa runner traffic ~0; external fetch rad etilsa stream fallback.
4. Mass uploadni faqat bitta fayl va keyin kichik batch muvaffaqiyatli o'tgandan keyin yoqing.

## Xavfsizlik

`TELETHON_SESSION` Telegram akkauntga kuchli kirish huquqi beradi. Uni repo, log yoki chatga joylamang.
Faqat tarqatish huquqi sizda bo'lgan media fayllarni yuboring.
