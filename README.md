# Telegram MTProto + Cloudflare external uploader

Bu loyiha katta videoni VPS diskiga yuklamasdan Telegram kanalga joylash uchun tayyorlangan.

## Oqim

1. Direct video URL `fayllar1.ru` da turadi.
2. Cloudflare Worker imzolangan `/proxy` URL orqali origin faylni byte-stream qiladi va `Range` so'rovlarini saqlab qoladi.
3. Telethon MTProto klienti `InputMediaDocumentExternal` bilan shu Cloudflare URL'ni Telegram'ga beradi.
4. Telegram serveri Worker URL'dan faylni o'zi yuklab oladi va kanalga joylaydi.

Shuning uchun MTProto runner video baytlarini o'zidan o'tkazmaydi; u faqat Telegram RPC chaqirig'ini yuboradi.

## Oldingi xatolar uchun tuzatishlar

- `Invalid channel object`: `@channel_username` yoki `TELEGRAM_CHANNEL_ACCESS_HASH` bilan robust peer resolve qo'shildi.
- `Failure while fetching the webpage with cURL`: original `fayllar1.ru` URL Telegramga bevosita berilmaydi; Cloudflare signed streaming proxy URL ishlatiladi.
- Katta fayl RAM muammosi: Worker `Response(upstream.body)` orqali streaming qiladi, to'liq faylni buffer qilmaydi.
- Range: `Range`, `If-Range`, `Content-Range`, `Accept-Ranges`, `Content-Length` kabi headerlar uzatiladi.
- Open proxy xavfi: faqat `fayllar1.ru` / subdomainlari allowlistda; URL HMAC-SHA256 bilan imzolanadi va muddati tugaydi.
- Telegram fetch retry: har urinishda yangi nonce bilan yangi proxy URL yaratiladi.
- Uploaddan oldin HEAD va `bytes=0-1023` probe ishlaydi.

## Cloudflare secrets

Worker uchun:

- `PROXY_SECRET` — uzun tasodifiy secret.
- `ADMIN_KEY` — faqat `/sign` diagnostik endpointi uchun.

GitHub Actions uchun:

- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELETHON_SESSION`
- `TELEGRAM_CHANNEL` — eng yaxshi variant `@channel_username`.
- `TELEGRAM_CHANNEL_ACCESS_HASH` — faqat numeric kanal ID ishlatilsa kerak bo'lishi mumkin.
- `CF_PROXY_BASE` — masalan `https://telegram-mtproto-stream-proxy.<subdomain>.workers.dev`.
- `CF_PROXY_SECRET` — Worker'dagi `PROXY_SECRET` bilan bir xil.

Cloudflare deploy workflow uchun qo'shimcha:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Session yaratish

Bir martalik interaktiv login uchun `mtproto/make_session.py` ishlatiladi. Olingan `TELETHON_SESSION` GitHub secret sifatida saqlanadi. Sessionni public repo ichiga yozmang.

## Test

Avval GitHub Actions → `MTProto external upload` → `dry_run=true` bilan kichik MP4 URL yuboring. Proxy HEAD/Range testi muvaffaqiyatli bo'lsa, `dry_run=false` bilan real kanal testini ishlating.

## Muhim

Faqat tarqatish huquqi sizda bo'lgan media fayllarni kanalga joylang.
