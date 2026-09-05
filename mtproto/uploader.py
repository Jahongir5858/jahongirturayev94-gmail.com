"""Telegram'ga katta video joylash: external fetch + streaming fallback.

Ikki rejim:

  external — Telegram serveri Cloudflare proxy URL'dan faylni O'ZI oladi.
             Trafik runner'dan o'tmaydi. MTProto `InputMediaDocumentExternal`
             uchun rasmiy 20 MB limit hujjatlashtirilmagan; 20 MB — Bot API
             URL-upload limiti. Shu sabab auto rejim avval external'ni sinaydi.

  stream   — runner faylni manbadan chunk-chunk o'qib, to'g'ridan-to'g'ri
             MTProto'ga uzatadi. Diskka yozilmaydi, RAM ~bir necha MB.
             Trafik runner'dan o'tadi (kirish + chiqish = 2x hajm).

Default `auto`: avval external sinanadi; faqat external-fetch xatosi bo'lsa
stream fallback ishlaydi. `EXTERNAL_MAX_BYTES` > 0 qilib ixtiyoriy cap qo'yish mumkin.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

import aiohttp
from telethon import TelegramClient, functions, helpers, types
from telethon.errors import FloodWaitError, RPCError
from telethon.sessions import StringSession

from media_source import (
    STREAM_TIMEOUT,
    ExactLengthReader,
    ProbeResult,
    gather_video_metadata,
    probe,
)
from proxy_url import build_signed_proxy_url

DEFAULT_EXTERNAL_MAX_BYTES = 0
DEFAULT_ORIGIN_REFERER = "https://asilmedia.org/"
DEFAULT_ORIGIN_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Safari/537.36"
)


def _env_int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        value = default
    else:
        try:
            value = int(raw)
        except ValueError as exc:
            raise RuntimeError(f"{name} must be an integer") from exc
    if minimum is not None and value < minimum:
        raise RuntimeError(f"{name} must be >= {minimum}")
    return value


EXTERNAL_FETCH_MARKERS = {
    "WEBPAGE_CURL_FAILED",
    "WEBPAGE_MEDIA_EMPTY",
    "WEBPAGE_NOT_FOUND",
    "WEBPAGE_URL_INVALID",
    "WEBDOCUMENT_INVALID",
    "WEBDOCUMENT_MIME_INVALID",
    "WEBDOCUMENT_SIZE_TOO_BIG",
    "MEDIA_INVALID",
    "VIDEO_CONTENT_TYPE_INVALID",
}


def _is_external_fetch_error(exc: BaseException) -> bool:
    text = " ".join([
        type(exc).__name__,
        str(getattr(exc, "message", "")),
        str(exc),
    ]).upper()
    normalized = re.sub(r"[^A-Z0-9]", "", text)
    return any(re.sub(r"[^A-Z0-9]", "", marker) in normalized for marker in EXTERNAL_FETCH_MARKERS)


@dataclass(frozen=True)
class Settings:
    api_id: int
    api_hash: str
    session: str
    channel: str
    channel_access_hash: str
    proxy_base: str
    proxy_secret: str
    proxy_ttl: int = 7200
    retries: int = 3
    external_max_bytes: int = DEFAULT_EXTERNAL_MAX_BYTES
    stream_via_proxy: bool = False
    origin_referer: str = DEFAULT_ORIGIN_REFERER
    origin_user_agent: str = DEFAULT_ORIGIN_USER_AGENT

    @classmethod
    def from_env(cls) -> "Settings":
        raw_api_id = os.getenv("TELEGRAM_API_ID", "").strip()
        api_id = int(raw_api_id) if raw_api_id.isdigit() else 0
        values = {
            "TELEGRAM_API_ID": api_id,
            "TELEGRAM_API_HASH": os.getenv("TELEGRAM_API_HASH", "").strip(),
            "TELETHON_SESSION": os.getenv("TELETHON_SESSION", "").strip(),
            "TELEGRAM_CHANNEL": os.getenv("TELEGRAM_CHANNEL", "").strip(),
            "CF_PROXY_BASE": os.getenv("CF_PROXY_BASE", "").strip(),
            "CF_PROXY_SECRET": os.getenv("CF_PROXY_SECRET", "").strip(),
        }
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise RuntimeError("Missing environment variables: " + ", ".join(missing))
        return cls(
            api_id=api_id,
            api_hash=values["TELEGRAM_API_HASH"],
            session=values["TELETHON_SESSION"],
            channel=values["TELEGRAM_CHANNEL"],
            channel_access_hash=os.getenv("TELEGRAM_CHANNEL_ACCESS_HASH", "").strip(),
            proxy_base=values["CF_PROXY_BASE"],
            proxy_secret=values["CF_PROXY_SECRET"],
            proxy_ttl=_env_int("CF_PROXY_TTL", 7200, 60),
            retries=_env_int("MTPROTO_RETRIES", 3, 1),
            external_max_bytes=_env_int("EXTERNAL_MAX_BYTES", DEFAULT_EXTERNAL_MAX_BYTES, 0),
            stream_via_proxy=os.getenv("STREAM_VIA_PROXY", "").lower() in {"1", "true", "yes"},
            origin_referer=os.getenv("ORIGIN_REFERER", DEFAULT_ORIGIN_REFERER).strip() or DEFAULT_ORIGIN_REFERER,
            origin_user_agent=os.getenv("ORIGIN_USER_AGENT", DEFAULT_ORIGIN_USER_AGENT).strip() or DEFAULT_ORIGIN_USER_AGENT,
        )


def log(event: dict[str, Any], error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    print(json.dumps(event, ensure_ascii=False), file=stream, flush=True)


def _channel_id_from_bot_api_id(raw: int) -> int:
    text = str(raw)
    if text.startswith("-100"):
        return int(text[4:])
    return abs(raw)


async def resolve_peer(client: TelegramClient, channel: str, access_hash: str = ""):
    value = channel.strip()
    if value.startswith("@") or not value.lstrip("-").isdigit():
        return await client.get_input_entity(value)
    raw = int(value)
    if access_hash:
        try:
            return types.InputPeerChannel(
                channel_id=_channel_id_from_bot_api_id(raw),
                access_hash=int(access_hash),
            )
        except ValueError as exc:
            raise RuntimeError("TELEGRAM_CHANNEL_ACCESS_HASH must be an integer") from exc
    try:
        return await client.get_input_entity(raw)
    except Exception as exc:
        raise RuntimeError(
            "Numeric channel ID is not in the Telethon entity cache. "
            "Use @channel_username, or set TELEGRAM_CHANNEL_ACCESS_HASH."
        ) from exc


def filename_from_url(url: str, fallback: str = "video.mp4") -> str:
    path = urlsplit(url).path
    name = unquote(path.rsplit("/", 1)[-1]).strip()
    return name or fallback


def find_message_id(updates: Any) -> int | None:
    for update in getattr(updates, "updates", []) or []:
        message = getattr(update, "message", None)
        if message is not None and getattr(message, "id", None):
            return int(message.id)
    return None


async def send_external(client: TelegramClient, peer, proxy_url: str, caption: str) -> dict[str, Any]:
    updates = await client(functions.messages.SendMediaRequest(
        peer=peer,
        media=types.InputMediaDocumentExternal(url=proxy_url),
        message=(caption or "")[:1024],
        random_id=helpers.generate_random_long(),
    ))
    return {"mode": "external", "message_id": find_message_id(updates)}


async def send_streamed(
    client: TelegramClient,
    peer,
    session: aiohttp.ClientSession,
    fetch_url: str,
    size: int,
    file_name: str,
    caption: str,
    metadata_url: str,
    request_headers: dict[str, str] | None = None,
    mime_type: str = "video/mp4",
) -> dict[str, Any]:
    meta, thumb_path = await gather_video_metadata(metadata_url)

    attributes: list[types.TypeDocumentAttribute] = [types.DocumentAttributeFilename(file_name)]
    if meta.get("width") and meta.get("height"):
        attributes.insert(0, types.DocumentAttributeVideo(
            duration=int(meta.get("duration") or 0),
            w=int(meta["width"]),
            h=int(meta["height"]),
            supports_streaming=True,
        ))

    last_pct = -5

    async def progress(sent: int, total: int) -> None:
        nonlocal last_pct
        pct = int(sent * 100 / total) if total else 0
        if pct >= last_pct + 5:
            last_pct = pct
            log({"stage": "upload_progress", "percent": pct, "sent": sent, "total": total})

    headers = {"Accept-Encoding": "identity", **(request_headers or {})}
    async with session.get(fetch_url, headers=headers, timeout=STREAM_TIMEOUT) as resp:
        resp.raise_for_status()
        content_range = resp.headers.get("Content-Range", "")
        observed_size: int | None = None
        if "/" in content_range:
            tail = content_range.rsplit("/", 1)[-1].strip()
            if tail.isdigit():
                observed_size = int(tail)
        if observed_size is None:
            length = resp.headers.get("Content-Length", "")
            if length.isdigit() and resp.status == 200:
                observed_size = int(length)
        if observed_size is not None and observed_size != size:
            raise RuntimeError(
                f"Source size changed between probe and upload: expected {size}, got {observed_size}"
            )
        reader = ExactLengthReader(resp, file_name)
        handle = await client.upload_file(
            reader,
            file_size=size,
            file_name=file_name,
            part_size_kb=512,
            progress_callback=progress,
        )

    message = await client.send_file(
        peer,
        handle,
        caption=(caption or "")[:1024],
        attributes=attributes,
        mime_type=mime_type,
        supports_streaming=True,
        thumb=thumb_path,
        force_document=False,
    )
    try:
        return {
            "mode": "stream",
            "message_id": getattr(message, "id", None),
            "metadata": meta,
            "thumbnail": bool(thumb_path),
        }
    finally:
        if thumb_path:
            with contextlib.suppress(OSError):
                os.remove(thumb_path)


async def run(source_url: str, caption: str, mode: str, dry_run: bool) -> dict[str, Any]:
    cfg = Settings.from_env()
    file_name = filename_from_url(source_url)

    connector = aiohttp.TCPConnector(limit=8, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as http:
        proxy_url = build_signed_proxy_url(cfg.proxy_base, source_url, cfg.proxy_secret, ttl=cfg.proxy_ttl)
        try:
            result: ProbeResult = await probe(http, proxy_url)
        except aiohttp.ClientError as exc:
            raise RuntimeError(f"Cloudflare proxy probe failed: {exc}") from exc
        if result.status not in {200, 206}:
            raise RuntimeError(f"Cloudflare proxy returned HTTP {result.status}")

        chosen = mode
        if mode == "auto":
            if cfg.external_max_bytes > 0 and result.size is not None and result.size > cfg.external_max_bytes:
                chosen = "stream"
            else:
                chosen = "external"

        log({
            "stage": "probe",
            "file_name": file_name,
            "proxy": result.as_dict(),
            "requested_mode": mode,
            "chosen_mode": chosen,
            "external_auto_cap_mb": (
                round(cfg.external_max_bytes / 1048576, 1) if cfg.external_max_bytes > 0 else None
            ),
        })

        if chosen == "stream" and result.size is None:
            raise RuntimeError(
                "Streaming upload needs the exact file size, but the origin did not "
                "return Content-Length or Content-Range."
            )

        if dry_run:
            return {"ok": True, "dry_run": True, "chosen_mode": chosen,
                    "proxy_url": proxy_url, "probe": result.as_dict()}

        last_error: Exception | None = None
        async with TelegramClient(StringSession(cfg.session), cfg.api_id, cfg.api_hash) as client:
            me = await client.get_me()
            peer = await resolve_peer(client, cfg.channel, cfg.channel_access_hash)
            log({
                "stage": "connected",
                "telegram_user_id": getattr(me, "id", None),
                "premium": bool(getattr(me, "premium", False)),
            })

            stream_use_proxy = cfg.stream_via_proxy
            for attempt in range(1, cfg.retries + 1):
                try:
                    if chosen == "external":
                        fresh = build_signed_proxy_url(
                            cfg.proxy_base, source_url, cfg.proxy_secret, ttl=cfg.proxy_ttl)
                        outcome = await send_external(client, peer, fresh, caption)
                    else:
                        fetch_url = proxy_url if stream_use_proxy else source_url
                        request_headers = None if stream_use_proxy else {
                            "User-Agent": cfg.origin_user_agent,
                            "Referer": cfg.origin_referer,
                        }
                        mime_type = (result.content_type or "video/mp4").split(";", 1)[0].strip()
                        if not mime_type or mime_type == "application/octet-stream":
                            mime_type = "video/mp4"
                        outcome = await send_streamed(
                            client, peer, http, fetch_url, result.size, file_name,
                            caption, metadata_url=proxy_url, request_headers=request_headers,
                            mime_type=mime_type,
                        )
                    return {"ok": True, "attempt": attempt, **outcome}

                except FloodWaitError as exc:
                    last_error = exc
                    log({"stage": "flood_wait", "attempt": attempt, "seconds": exc.seconds}, error=True)
                    if attempt >= cfg.retries or exc.seconds > 900:
                        break
                    await asyncio.sleep(exc.seconds + 5)

                except (RPCError, aiohttp.ClientError, asyncio.TimeoutError, ConnectionError, OSError, ValueError) as exc:
                    last_error = exc
                    log({
                        "stage": "send_failed", "attempt": attempt, "mode": chosen,
                        "error_type": type(exc).__name__, "error": str(exc),
                    }, error=True)

                    if chosen == "external" and mode == "auto" and _is_external_fetch_error(exc):
                        if result.size is None:
                            raise RuntimeError(
                                "External fetch failed and stream fallback cannot start because file size is unknown"
                            ) from exc
                        log({"stage": "fallback", "from": "external", "to": "stream"}, error=True)
                        chosen = "stream"
                        continue

                    if isinstance(exc, RPCError):
                        raise

                    if chosen == "stream" and not stream_use_proxy and attempt < cfg.retries:
                        stream_use_proxy = True
                        log({"stage": "fallback", "from": "direct_stream", "to": "proxy_stream"}, error=True)
                        continue

                    if attempt >= cfg.retries:
                        break
                    await asyncio.sleep(min(30, 2 ** attempt))

    raise RuntimeError(f"Upload failed after {cfg.retries} attempts: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload a large external video to Telegram via MTProto")
    parser.add_argument("--url", required=True, help="Direct source media URL")
    parser.add_argument("--caption", default="", help="Telegram caption")
    parser.add_argument("--mode", choices=["auto", "external", "stream"], default="auto",
                        help="auto: external-first with stream fallback; external: Telegram fetches the URL; "
                             "stream: runner pipes bytes to MTProto")
    parser.add_argument("--dry-run", action="store_true",
                        help="Only probe the proxy and report the chosen mode")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        print(json.dumps(asyncio.run(run(args.url, args.caption, args.mode, args.dry_run)),
                         ensure_ascii=False), flush=True)
    except Exception as exc:
        log({"ok": False, "error_type": type(exc).__name__, "error": str(exc)}, error=True)
        sys.exit(1)
