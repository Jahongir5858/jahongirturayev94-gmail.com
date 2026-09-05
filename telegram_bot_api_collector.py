#!/usr/bin/env python3
"""Telegram Bot API -> Telegram Search Engine PostgreSQL collector.

No MTProto user account is used. The bot receives new channel_post / edited_channel_post
updates only from channels where the bot is present, stores them in the upstream
Telegram-Search-Engine schema, and refreshes PostgreSQL full-text search metadata.
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

LOG = logging.getLogger("bot_api_collector")
TOKEN = os.environ.get("BOT_TOKEN", "").strip()
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://tgsearch:preview-postgres-9f3c7b1a@127.0.0.1:5432/tgsearch",
).strip()
POLL_TIMEOUT = max(5, min(50, int(os.environ.get("BOT_POLL_TIMEOUT", "30"))))
SUMMARY_MESSAGES = max(5, min(100, int(os.environ.get("BOT_SUMMARY_MESSAGES", "30"))))
STOP = False
URL_RE = re.compile(r"https?://|(?:^|\s)t\.me/|(?:^|\s)@[A-Za-z0-9_]{5,}", re.I)


def _stop(*_: Any) -> None:
    global STOP
    STOP = True


def bot_api(method: str, payload: dict[str, Any] | None = None, timeout: int = 60) -> Any:
    if not TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = urllib.parse.urlencode(payload or {}).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"Bot API HTTP {exc.code}: {text}") from exc
    if not body.get("ok"):
        raise RuntimeError(f"Bot API error: {body.get('description', 'unknown error')}")
    return body.get("result")


def text_of(message: dict[str, Any]) -> str:
    return (message.get("text") or message.get("caption") or "").strip()


def has_link(message: dict[str, Any], text: str) -> bool:
    if URL_RE.search(text):
        return True
    for key in ("entities", "caption_entities"):
        for ent in message.get(key) or []:
            if ent.get("type") in {"url", "text_link", "mention"}:
                return True
    return False


def has_image(message: dict[str, Any]) -> bool:
    return bool(message.get("photo") or message.get("animation") or message.get("video") or message.get("document"))


def channel_username(chat: dict[str, Any]) -> str | None:
    value = (chat.get("username") or "").strip()
    return value.lower() if value else None


def upsert_channel(conn: psycopg.Connection, chat: dict[str, Any]) -> int:
    tg_id = int(chat["id"])
    username = channel_username(chat)
    title = (chat.get("title") or username or str(tg_id)).strip()
    row = conn.execute(
        """
        SELECT id FROM channels
        WHERE tg_id = %s OR (%s IS NOT NULL AND lower(username) = lower(%s))
        ORDER BY (tg_id = %s) DESC
        LIMIT 1
        """,
        (tg_id, username, username, tg_id),
    ).fetchone()
    if row:
        channel_id = int(row["id"])
        conn.execute(
            """
            UPDATE channels
            SET tg_id=%s,
                username=COALESCE(%s, username),
                title=%s,
                discovered_by_keyword='bot-api',
                last_crawled_at=now()
            WHERE id=%s
            """,
            (tg_id, username, title, channel_id),
        )
        return channel_id
    row = conn.execute(
        """
        INSERT INTO channels (tg_id, username, title, discovered_by_keyword, last_crawled_at)
        VALUES (%s, %s, %s, 'bot-api', now())
        RETURNING id
        """,
        (tg_id, username, title),
    ).fetchone()
    return int(row["id"])


def refresh_search_summary(conn: psycopg.Connection, channel_id: int) -> None:
    rows = conn.execute(
        """
        SELECT text FROM messages
        WHERE channel_id=%s AND NULLIF(btrim(text), '') IS NOT NULL
        ORDER BY posted_at DESC NULLS LAST, id DESC
        LIMIT %s
        """,
        (channel_id, SUMMARY_MESSAGES),
    ).fetchall()
    summary = " \n ".join(r["text"].strip() for r in rows if r.get("text"))[:12000]
    conn.execute(
        """
        INSERT INTO channel_analysis (
            channel_id, category, is_marketplace, confidence, summary,
            tone, typical_content, why_recommended,
            activity_score, quality_score, freshness_score, final_score, analyzed_at
        ) VALUES (
            %s, 'bot-api', false, 1.0, %s,
            'live feed', 'Bot API channel posts', 'Collected directly through Telegram Bot API',
            60, 60, 100, 70, now()
        )
        ON CONFLICT (channel_id) DO UPDATE SET
            category='bot-api',
            confidence=1.0,
            summary=EXCLUDED.summary,
            typical_content=EXCLUDED.typical_content,
            why_recommended=EXCLUDED.why_recommended,
            activity_score=EXCLUDED.activity_score,
            quality_score=EXCLUDED.quality_score,
            freshness_score=EXCLUDED.freshness_score,
            final_score=EXCLUDED.final_score,
            analyzed_at=now()
        """,
        (channel_id, summary),
    )
    conn.execute(
        "UPDATE channels SET search_tsv = channels_build_tsv(%s) WHERE id=%s",
        (channel_id, channel_id),
    )


def store_post(conn: psycopg.Connection, message: dict[str, Any]) -> tuple[int, int]:
    chat = message.get("chat") or {}
    if chat.get("type") != "channel":
        return (0, 0)
    channel_id = upsert_channel(conn, chat)
    text = text_of(message)
    posted_at = datetime.fromtimestamp(int(message.get("date", time.time())), tz=timezone.utc)
    before = conn.execute(
        "SELECT 1 FROM messages WHERE channel_id=%s AND tg_message_id=%s",
        (channel_id, int(message["message_id"])),
    ).fetchone()
    conn.execute(
        """
        INSERT INTO messages (channel_id, tg_message_id, text, has_image, has_link, posted_at)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (channel_id, tg_message_id) DO UPDATE SET
            text=EXCLUDED.text,
            has_image=EXCLUDED.has_image,
            has_link=EXCLUDED.has_link,
            posted_at=EXCLUDED.posted_at,
            fetched_at=now()
        """,
        (
            channel_id,
            int(message["message_id"]),
            text,
            has_image(message),
            has_link(message, text),
            posted_at,
        ),
    )
    refresh_search_summary(conn, channel_id)
    return channel_id, 0 if before else 1


def process_update(conn: psycopg.Connection, update: dict[str, Any]) -> None:
    message = update.get("channel_post") or update.get("edited_channel_post")
    if message:
        channel_id, inserted = store_post(conn, message)
        conn.commit()
        chat = message.get("chat") or {}
        LOG.info(
            "indexed channel=%s db_id=%s message_id=%s new=%s",
            chat.get("username") or chat.get("title") or chat.get("id"),
            channel_id,
            message.get("message_id"),
            bool(inserted),
        )
        return
    membership = update.get("my_chat_member")
    if membership:
        chat = membership.get("chat") or {}
        if chat.get("type") == "channel":
            status = ((membership.get("new_chat_member") or {}).get("status") or "unknown")
            LOG.info("bot membership changed channel=%s status=%s", chat.get("title") or chat.get("id"), status)


def run() -> int:
    if not TOKEN:
        LOG.error("BOT_TOKEN is missing. Add it as a secret; no Telegram user account is required.")
        return 2
    me = bot_api("getMe")
    LOG.info("Bot API connected as @%s", me.get("username", "unknown"))
    offset = 0
    allowed = json.dumps(["channel_post", "edited_channel_post", "my_chat_member"])
    with psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False) as conn:
        while not STOP:
            try:
                updates = bot_api(
                    "getUpdates",
                    {
                        "offset": offset,
                        "timeout": POLL_TIMEOUT,
                        "allowed_updates": allowed,
                    },
                    timeout=POLL_TIMEOUT + 15,
                )
                for update in updates or []:
                    offset = max(offset, int(update["update_id"]) + 1)
                    try:
                        process_update(conn, update)
                    except Exception:
                        conn.rollback()
                        LOG.exception("failed to process update_id=%s", update.get("update_id"))
            except Exception:
                LOG.exception("Bot API polling error")
                time.sleep(5)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    sys.exit(run())
