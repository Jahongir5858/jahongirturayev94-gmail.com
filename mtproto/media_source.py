"""Manba faylni tekshirish va Telethon uchun stream reader."""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any

import aiohttp

PROBE_TIMEOUT = aiohttp.ClientTimeout(total=45, connect=15)
STREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=30, sock_read=120)


@dataclass(frozen=True)
class ProbeResult:
    url: str
    status: int
    size: int | None
    content_type: str | None
    accept_ranges: bool
    first_bytes: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "size": self.size,
            "size_mb": round(self.size / 1048576, 2) if self.size else None,
            "content_type": self.content_type,
            "accept_ranges": self.accept_ranges,
            "first_bytes": self.first_bytes,
        }


class ExactLengthReader:
    """Telethon `upload_file` uchun adapter.

    Telethon oxirgi chunkdan boshqa har bir `read(n)` chaqiruvidan ANIQ n bayt
    kutadi; aiohttp `read(n)` esa ko'pi bilan n bayt qaytaradi. Shu sabab
    to'lguncha o'qiymiz.
    """

    def __init__(self, response: aiohttp.ClientResponse, name: str) -> None:
        self._response = response
        self._eof = False
        self.name = name

    async def read(self, size: int) -> bytes:
        buffer = bytearray()
        while len(buffer) < size and not self._eof:
            chunk = await self._response.content.read(size - len(buffer))
            if not chunk:
                self._eof = True
                break
            buffer.extend(chunk)
        return bytes(buffer)


async def probe(session: aiohttp.ClientSession, url: str) -> ProbeResult:
    """Hajm va Range qo'llab-quvvatlashini bytes=0-1023 bilan aniqlaydi."""
    headers = {"Range": "bytes=0-1023", "Accept-Encoding": "identity"}
    async with session.get(url, headers=headers, timeout=PROBE_TIMEOUT) as resp:
        first = await resp.content.read(1024)
        size: int | None = None
        content_range = resp.headers.get("Content-Range")
        if content_range and "/" in content_range:
            tail = content_range.rsplit("/", 1)[-1].strip()
            if tail.isdigit():
                size = int(tail)
        if size is None:
            length = resp.headers.get("Content-Length")
            if length and length.isdigit() and resp.status == 200:
                size = int(length)
        # Range e'tiborsiz qoldirilsa status=200 bilan ko'p-GB fayl kelishi mumkin.
        # Qolgan body'ni drain qilmaymiz, aks holda probe butun videoni yuklab yuboradi.
        resp.close()
        return ProbeResult(
            url=url,
            status=resp.status,
            size=size,
            content_type=resp.headers.get("Content-Type"),
            accept_ranges=resp.status == 206 or resp.headers.get("Accept-Ranges") == "bytes",
            first_bytes=len(first),
        )


def _run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


def ffprobe_metadata(url: str) -> dict[str, Any]:
    if not shutil.which("ffprobe"):
        return {}
    proc = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "default=noprint_wrappers=1:nokey=0", url,
    ])
    if proc.returncode != 0:
        return {}
    data: dict[str, Any] = {}
    for line in proc.stdout.splitlines():
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key in {"width", "height"} and value.isdigit():
            data[key] = int(value)
        elif key == "duration":
            with contextlib.suppress(ValueError):
                data["duration"] = int(float(value))
    return data


def make_thumbnail(url: str, seek: int = 5) -> str | None:
    if not shutil.which("ffmpeg"):
        return None
    path = os.path.join(tempfile.gettempdir(), "tg_thumb.jpg")
    proc = _run([
        "ffmpeg", "-y", "-v", "error", "-ss", str(seek), "-i", url,
        "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", path,
    ], timeout=180)
    if proc.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    return None


async def gather_video_metadata(url: str) -> tuple[dict[str, Any], str | None]:
    meta = await asyncio.to_thread(ffprobe_metadata, url)
    thumb = await asyncio.to_thread(make_thumbnail, url)
    return meta, thumb
