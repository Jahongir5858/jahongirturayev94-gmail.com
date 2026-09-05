import os
import sys
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "mtproto"))

from proxy_url import build_signed_proxy_url, validate_source_url


def test_signed_url_shape():
    out = build_signed_proxy_url(
        "https://worker.example.workers.dev",
        "https://30.fayllar1.ru/30/kinolar/Test%20Movie.mp4",
        "secret",
        ttl=3600,
        nonce="abc123",
    )
    parsed = urlparse(out)
    q = parse_qs(parsed.query)
    assert parsed.path == "/proxy"
    assert q["n"] == ["abc123"]
    assert len(q["s"][0]) == 64
    assert "u" in q and "e" in q


def test_reject_non_http():
    try:
        validate_source_url("file:///etc/passwd")
    except ValueError:
        return
    raise AssertionError("non-http URL must be rejected")
