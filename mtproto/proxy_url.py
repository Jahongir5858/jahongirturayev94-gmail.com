from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import urlencode, urlsplit


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def validate_source_url(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Source URL must be an absolute http(s) URL")
    return url


def build_signed_proxy_url(base_url: str, source_url: str, secret: str, ttl: int = 3600, nonce: str | None = None) -> str:
    source_url = validate_source_url(source_url)
    if not secret:
        raise ValueError("Proxy secret is empty")
    ttl = max(60, min(int(ttl), 86400))
    exp = int(time.time()) + ttl
    nonce = nonce or secrets.token_hex(12)
    payload = f"{exp}\n{nonce}\n{source_url}"
    sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    query = urlencode({"u": _b64url(source_url), "e": exp, "n": nonce, "s": sig})
    return f"{base_url.rstrip('/')}/proxy?{query}"
