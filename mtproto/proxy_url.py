"""Cloudflare Worker uchun imzolangan proxy URL yasash.

MUHIM: imzo base64url TOKEN ustidan hisoblanadi, xom URL matni ustidan emas.
Ilgari Python xom URL'ni, Worker esa `new URL(u).toString()` natijasini
imzolardi. WHATWG URL normalizatsiyasi probelni `%20` ga aylantirgani uchun
har qanday probelli kino nomida imzo mos kelmay `403 Bad signature` chiqardi.
Token — o'zgarmas bayt ketma-ketligi, ikkala tomon aynan bir xil narsani ko'radi.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import quote, unquote, urlsplit


def b64url_encode(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def b64url_decode(token: str) -> str:
    padded = token + "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def validate_source_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Source URL must be an absolute http(s) URL")
    if any(ch in url for ch in ("\n", "\r", "\t")):
        raise ValueError("Source URL must not contain control characters")
    return url


def _proxy_filename(source_url: str) -> str:
    path = urlsplit(source_url).path
    name = unquote(path.rsplit("/", 1)[-1]).strip() or "video.mp4"
    return quote(name, safe="._-()[]")


def sign_payload(secret: str, exp: int, nonce: str, token: str) -> str:
    payload = f"{exp}\n{nonce}\n{token}"
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def build_signed_proxy_url(
    base_url: str,
    source_url: str,
    secret: str,
    ttl: int = 3600,
    nonce: str | None = None,
) -> str:
    source_url = validate_source_url(source_url)
    if not secret:
        raise ValueError("Proxy secret is empty")
    ttl = max(60, min(int(ttl), 86400))
    exp = int(time.time()) + ttl
    nonce = nonce or secrets.token_hex(12)
    token = b64url_encode(source_url)
    sig = sign_payload(secret, exp, nonce, token)
    filename = _proxy_filename(source_url)
    return f"{base_url.rstrip('/')}/proxy/{filename}?u={token}&e={exp}&n={nonce}&s={sig}"
