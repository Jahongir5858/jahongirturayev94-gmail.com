import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "mtproto"))

from media_source import ExactLengthReader  # noqa: E402


class FakeContent:
    def __init__(self, data: bytes, max_chunk: int):
        self.data = data
        self.max_chunk = max_chunk
        self.pos = 0

    async def read(self, n: int) -> bytes:
        take = min(n, self.max_chunk, len(self.data) - self.pos)
        chunk = self.data[self.pos:self.pos + take]
        self.pos += take
        return chunk


class FakeResponse:
    def __init__(self, data: bytes, max_chunk: int):
        self.content = FakeContent(data, max_chunk)


@pytest.mark.asyncio
@pytest.mark.parametrize("max_chunk", [1, 7, 100, 4096])
async def test_reader_returns_exact_length(max_chunk):
    data = bytes(range(256)) * 40
    reader = ExactLengthReader(FakeResponse(data, max_chunk), "x.mp4")
    part = 1024
    collected = bytearray()
    while True:
        chunk = await reader.read(part)
        if not chunk:
            break
        collected.extend(chunk)
        if len(chunk) < part:
            break
    assert bytes(collected) == data


@pytest.mark.asyncio
async def test_reader_signals_eof_with_empty_bytes():
    reader = ExactLengthReader(FakeResponse(b"abc", 1), "x.mp4")
    assert await reader.read(1024) == b"abc"
    assert await reader.read(1024) == b""


class TrackingContent:
    def __init__(self):
        self.calls = []

    async def read(self, n=-1):
        self.calls.append(n)
        if len(self.calls) == 1:
            return b"x" * min(1024, n)
        raise AssertionError("probe must not drain the rest of a potentially huge response")


class ProbeResponse:
    def __init__(self):
        self.status = 200
        self.headers = {"Content-Length": str(4 * 1024**3), "Content-Type": "video/mp4"}
        self.content = TrackingContent()
        self.closed = False

    def close(self):
        self.closed = True


class ProbeContext:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response

    async def __aexit__(self, exc_type, exc, tb):
        return False


class ProbeSession:
    def __init__(self, response):
        self.response = response

    def get(self, *args, **kwargs):
        return ProbeContext(self.response)


@pytest.mark.asyncio
async def test_probe_does_not_drain_full_body_when_range_is_ignored():
    from media_source import probe

    response = ProbeResponse()
    result = await probe(ProbeSession(response), "https://example.test/video.mp4")
    assert result.status == 200
    assert result.size == 4 * 1024**3
    assert response.content.calls == [1024]
    assert response.closed is True
