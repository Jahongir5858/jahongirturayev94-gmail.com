from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from telethon import TelegramClient, functions, types
from telethon.errors import RPCError
from telethon.sessions import StringSession

from proxy_url import build_signed_proxy_url


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

    @classmethod
    def from_env(cls) -> "Settings":
        api_id = int(os.getenv("TELEGRAM_API_ID", "0"))
        api_hash = os.getenv("TELEGRAM_API_HASH", "").strip()
        session = os.getenv("TELETHON_SESSION", "").strip()
        channel = os.getenv("TELEGRAM_CHANNEL", "").strip()
        access_hash = os.getenv("TELEGRAM_CHANNEL_ACCESS_HASH", "").strip()
        proxy_base = os.getenv("CF_PROXY_BASE", "").strip()
        proxy_secret = os.getenv("CF_PROXY_SECRET", "").strip()
        missing = [name for name, value in {
            "TELEGRAM_API_ID": api_id,
            "TELEGRAM_API_HASH": api_hash,
            "TELETHON_SESSION": session,
            "TELEGRAM_CHANNEL": channel,
            "CF_PROXY_BASE": proxy_base,
            "CF_PROXY_SECRET": proxy_secret,
        }.items() if not value]
        if missing:
            raise RuntimeError("Missing environment variables: " + ", ".join(missing))
        return cls(
            api_id=api_id, api_hash=api_hash, session=session, channel=channel,
            channel_access_hash=access_hash, proxy_base=proxy_base, proxy_secret=proxy_secret,
            proxy_ttl=int(os.getenv("CF_PROXY_TTL", "7200")),
            retries=max(1, int(os.getenv("MTPROTO_RETRIES", "3"))),
        )


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
        return types.InputPeerChannel(
            channel_id=_channel_id_from_bot_api_id(raw),
            access_hash=int(access_hash),
        )
    try:
        return await client.get_input_entity(raw)
    except Exception as exc:
        raise RuntimeError(
            "Numeric channel ID is not present in the Telethon entity cache. "
            "Use @channel_username or set TELEGRAM_CHANNEL_ACCESS_HASH."
        ) from exc


def probe_proxy(url: str) -> dict[str, Any]:
    result: dict[str, Any] = {"url": url}
    try:
        req = Request(url, method="HEAD", headers={"User-Agent": "TelegramExternalProbe/1.0"})
        with urlopen(req, timeout=25) as resp:
            result.update({
                "head_status": resp.status,
                "content_type": resp.headers.get("content-type"),
                "content_length": resp.headers.get("content-length"),
                "accept_ranges": resp.headers.get("accept-ranges"),
            })
    except HTTPError as exc:
        result["head_status"] = exc.code
        result["head_error"] = str(exc)
    except URLError as exc:
        raise RuntimeError(f"Cloudflare proxy HEAD probe failed: {exc}") from exc

    try:
        req = Request(url, method="GET", headers={"Range": "bytes=0-1023", "User-Agent": "TelegramExternalProbe/1.0"})
        with urlopen(req, timeout=25) as resp:
            first = resp.read(1024)
            result.update({
                "range_status": resp.status,
                "range_bytes": len(first),
                "content_range": resp.headers.get("content-range"),
            })
    except HTTPError as exc:
        result["range_status"] = exc.code
        result["range_error"] = str(exc)
        if exc.code >= 400:
            raise RuntimeError(f"Cloudflare proxy range probe failed with HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError(f"Cloudflare proxy range probe failed: {exc}") from exc

    if int(result.get("range_status") or 0) not in {200, 206}:
        raise RuntimeError(f"Unexpected proxy range status: {result.get('range_status')}")
    return result


def find_message_id(updates: Any) -> int | None:
    for update in getattr(updates, "updates", []) or []:
        message = getattr(update, "message", None)
        if message is not None and getattr(message, "id", None):
            return int(message.id)
    return None


async def upload_external(source_url: str, caption: str, dry_run: bool = False) -> dict[str, Any]:
    cfg = Settings.from_env()
    last_error: Exception | None = None

    async with TelegramClient(StringSession(cfg.session), cfg.api_id, cfg.api_hash) as client:
        me = await client.get_me()
        peer = await resolve_peer(client, cfg.channel, cfg.channel_access_hash)

        for attempt in range(1, cfg.retries + 1):
            proxy_url = build_signed_proxy_url(
                cfg.proxy_base, source_url, cfg.proxy_secret, ttl=cfg.proxy_ttl
            )
            probe = await asyncio.to_thread(probe_proxy, proxy_url)
            event = {
                "ok": True,
                "stage": "probe",
                "attempt": attempt,
                "telegram_user_id": getattr(me, "id", None),
                "proxy": probe,
            }
            print(json.dumps(event, ensure_ascii=False), flush=True)
            if dry_run:
                return {"ok": True, "dry_run": True, "proxy_url": proxy_url, "probe": probe}

            try:
                media = types.InputMediaDocumentExternal(url=proxy_url)
                updates = await client(functions.messages.SendMediaRequest(
                    peer=peer,
                    media=media,
                    message=(caption or "")[:1024],
                    random_id=random.getrandbits(63),
                ))
                return {
                    "ok": True,
                    "attempt": attempt,
                    "message_id": find_message_id(updates),
                    "proxy_url": proxy_url,
                }
            except RPCError as exc:
                last_error = exc
                print(json.dumps({
                    "ok": False,
                    "stage": "mtproto_send",
                    "attempt": attempt,
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                }, ensure_ascii=False), file=sys.stderr, flush=True)
                if attempt < cfg.retries:
                    await asyncio.sleep(min(20, 2 ** attempt))
                    continue
                break

    raise RuntimeError(f"MTProto external upload failed after {cfg.retries} attempts: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload an external URL to Telegram through Cloudflare proxy + MTProto")
    parser.add_argument("--url", required=True, help="Direct external media URL")
    parser.add_argument("--caption", default="", help="Telegram caption")
    parser.add_argument("--dry-run", action="store_true", help="Only verify the Cloudflare proxy; do not send to Telegram")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        result = asyncio.run(upload_external(args.url, args.caption, args.dry_run))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"ok": False, "error_type": type(exc).__name__, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise
