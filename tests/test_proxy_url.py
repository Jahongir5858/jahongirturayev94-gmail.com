import base64
import hashlib
import hmac
import os
import sys
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "mtproto"))

from proxy_url import (  # noqa: E402
    b64url_decode,
    build_signed_proxy_url,
    sign_payload,
    validate_source_url,
)

TRICKY_URLS = [
    "https://30.fayllar1.ru/30/kinolar/test.mp4",
    "https://30.fayllar1.ru/30/kinolar/Qora Ilon (Uzbek tilida).mp4",
    "https://30.fayllar1.ru/30/kinolar/Фильм 2024.mp4",
    "https://30.fayllar1.ru:443/30/kinolar/a+b&c.mp4",
    "https://30.FAYLLAR1.ru/30/kinolar/CamelCase.mp4",
]


def _params(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def test_signed_url_shape():
    out = build_signed_proxy_url(
        "https://worker.example.workers.dev",
        TRICKY_URLS[0], "secret", ttl=3600, nonce="abc123",
    )
    parsed = urlsplit(out)
    q = _params(out)
    assert parsed.path == "/proxy/test.mp4"
    assert q["n"] == "abc123"
    assert len(q["s"]) == 64
    assert b64url_decode(q["u"]) == TRICKY_URLS[0]


@pytest.mark.parametrize("url", TRICKY_URLS)
def test_signature_is_over_the_opaque_token(url):
    signed = build_signed_proxy_url("https://w.example", url, "secret", nonce="n")
    q = _params(signed)
    expected = hmac.new(
        b"secret", f"{q['e']}\nn\n{q['u']}".encode(), hashlib.sha256
    ).hexdigest()
    assert q["s"] == expected
    assert b64url_decode(q["u"]) == url


@pytest.mark.parametrize("url", TRICKY_URLS)
def test_token_roundtrip_is_lossless(url):
    signed = build_signed_proxy_url("https://w.example", url, "secret")
    assert b64url_decode(_params(signed)["u"]) == url


def test_query_params_are_url_safe():
    signed = build_signed_proxy_url("https://w.example", TRICKY_URLS[1], "secret")
    query = urlsplit(signed).query
    assert "%" not in query and " " not in query


def test_ttl_is_clamped():
    q = _params(build_signed_proxy_url("https://w.example", TRICKY_URLS[0], "s", ttl=10**9))
    q2 = _params(build_signed_proxy_url("https://w.example", TRICKY_URLS[0], "s", ttl=1))
    assert int(q2["e"]) - int(q["e"]) < 0


@pytest.mark.parametrize("bad", ["file:///etc/passwd", "ftp://x/y", "/relative", "https://"])
def test_reject_invalid_urls(bad):
    with pytest.raises(ValueError):
        validate_source_url(bad)


def test_reject_control_characters():
    with pytest.raises(ValueError):
        validate_source_url("https://30.fayllar1.ru/a\nHost: evil")


def test_empty_secret_rejected():
    with pytest.raises(ValueError):
        build_signed_proxy_url("https://w.example", TRICKY_URLS[0], "")


def test_sign_payload_matches_worker_format():
    assert sign_payload("k", 100, "n", "tok") == hmac.new(
        b"k", b"100\nn\ntok", hashlib.sha256
    ).hexdigest()
    assert base64.urlsafe_b64encode(b"x")
