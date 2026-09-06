#!/usr/bin/env python3
"""Collect public Telegram channel previews without MTProto/user sessions.

Reads https://t.me/s/<username>, extracts channel metadata and recent public posts,
and stores them in Brooksolomon/Telegram-Search-Engine's PostgreSQL schema.
"""
from __future__ import annotations

import html as html_lib
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://tgsearch:preview-postgres-9f3c7b1a@127.0.0.1:5432/tgsearch",
)
CHANNELS = [x.strip().lstrip("@").lower() for x in os.environ.get(
    "PUBLIC_TG_CHANNELS", "kunuz,gazetauz,qalampir"
).split(",") if x.strip()]

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
URL_RE = re.compile(r"https?://|t\.me/|@[A-Za-z0-9_]{4,}", re.I)


def clean_text(value: str) -> str:
    value = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    value = re.sub(r"<script\b[^>]*>[\s\S]*?</script>", " ", value, flags=re.I)
    value = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", " ", value, flags=re.I)
    value = TAG_RE.sub(" ", value)
    value = html_lib.unescape(value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n\s+", "\n", value)
    return value.strip()


def compact_number(raw: str | None) -> int | None:
    if raw is None:
        return None
    s = SPACE_RE.sub("", raw).replace("\xa0", "")
    if not s:
        return None
    mult = 1
    if s[-1:].lower() in {"k", "m", "b"}:
        suffix = s[-1].lower()
        s = s[:-1]
        mult = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}[suffix]
        if "," in s and "." not in s:
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    else:
        s = s.replace(",", "")
    try:
        return int(round(float(s) * mult))
    except ValueError:
        return None


def fetch_preview(username: str) -> str:
    req = urllib.request.Request(
        f"https://t.me/s/{username}",
        headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=35) as resp:
        return resp.read().decode("utf-8", "replace")[:3_500_000]


def meta_content(source: str, key: str) -> str:
    for tag in re.findall(r"<meta\b[^>]*>", source, flags=re.I):
        name_m = re.search(r"(?:name|property)\s*=\s*[\"']([^\"']+)", tag, flags=re.I)
        if not name_m or name_m.group(1).lower() != key.lower():
            continue
        content_m = re.search(r"content\s*=\s*[\"']([^\"']*)", tag, flags=re.I)
        if content_m:
            return html_lib.unescape(content_m.group(1)).strip()
    return ""


def parse_preview(username: str, source: str) -> dict:
    title = meta_content(source, "og:title") or f"@{username}"
    title = re.sub(r"\s*[–—-]\s*Telegram\s*$", "", title, flags=re.I).strip()
    visible = clean_text(source[:350_000])
    member_count = None
    for pattern in (
        r"([0-9][0-9.,]*\s*[KMB]?)\s+(?:subscribers?|members?)",
        r"(?:subscribers?|members?)\s*[:·-]?\s*([0-9][0-9.,]*\s*[KMB]?)",
    ):
        m = re.search(pattern, visible, flags=re.I)
        if m:
            member_count = compact_number(m.group(1))
            if member_count is not None:
                break

    hits = list(re.finditer(r"data-post=[\"']([^\"']+)[\"']", source, flags=re.I))[:100]
    posts: list[dict] = []
    for i, match in enumerate(hits):
        key = match.group(1)
        try:
            channel_name, raw_id = key.split("/", 1)
            message_id = int(raw_id)
        except (ValueError, TypeError):
            continue
        if channel_name.lower() != username.lower():
            continue
        end = hits[i + 1].start() if i + 1 < len(hits) else min(len(source), match.start() + 180_000)
        block = source[match.start():end]

        text_match = re.search(
            r"class=[\"'][^\"']*tgme_widget_message_text[^\"']*[\"'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=[\"'][^\"']*tgme_widget_message_(?:reactions|footer|info|date|views)|<a\b[^>]*class=[\"'][^\"']*tgme_widget_message_date)",
            block,
            flags=re.I,
        )
        post_text = clean_text(text_match.group(1))[:12_000] if text_match else ""
        time_match = re.search(r"<time\b[^>]*datetime=[\"']([^\"']+)", block, flags=re.I)
        posted_at = time_match.group(1) if time_match else None
        views_match = re.search(r"tgme_widget_message_views[^>]*>\s*([^<]+)", block, flags=re.I)
        views = compact_number(clean_text(views_match.group(1))) if views_match else 0
        media_lower = block.lower()
        has_image = "photo_wrap" in media_lower or "message_video" in media_lower or "<video" in media_lower
        has_link = bool(URL_RE.search(post_text) or re.search(r"<a\b", block, flags=re.I))
        posts.append({
            "message_id": message_id,
            "text": post_text,
            "posted_at": posted_at,
            "views": views or 0,
            "has_image": has_image,
            "has_link": has_link,
        })

    if not posts and member_count is None:
        raise RuntimeError(f"@{username}: Telegram public preview unavailable")
    return {"username": username, "title": title, "member_count": member_count, "posts": posts}


def store(conn: psycopg.Connection, parsed: dict) -> tuple[int, int]:
    row = conn.execute(
        "SELECT id FROM channels WHERE lower(username)=lower(%s) LIMIT 1",
        (parsed["username"],),
    ).fetchone()
    if row:
        channel_id = int(row["id"])
        conn.execute(
            """UPDATE channels
               SET title=%s, member_count=COALESCE(%s,member_count),
                   discovered_by_keyword='public-preview', last_crawled_at=now()
               WHERE id=%s""",
            (parsed["title"], parsed["member_count"], channel_id),
        )
    else:
        row = conn.execute(
            """INSERT INTO channels(username,title,member_count,discovered_by_keyword,last_crawled_at)
               VALUES(%s,%s,%s,'public-preview',now()) RETURNING id""",
            (parsed["username"], parsed["title"], parsed["member_count"]),
        ).fetchone()
        channel_id = int(row["id"])

    inserted = 0
    for post in parsed["posts"]:
        before = conn.execute(
            "SELECT 1 FROM messages WHERE channel_id=%s AND tg_message_id=%s",
            (channel_id, post["message_id"]),
        ).fetchone()
        conn.execute(
            """INSERT INTO messages(channel_id,tg_message_id,text,has_image,has_link,posted_at,fetched_at)
               VALUES(%s,%s,%s,%s,%s,%s,now())
               ON CONFLICT(channel_id,tg_message_id) DO UPDATE SET
                 text=excluded.text, has_image=excluded.has_image,
                 has_link=excluded.has_link, posted_at=excluded.posted_at,
                 fetched_at=now()""",
            (
                channel_id, post["message_id"], post["text"], post["has_image"],
                post["has_link"], post["posted_at"],
            ),
        )
        if not before:
            inserted += 1

    summary_parts = [p["text"] for p in parsed["posts"] if p["text"]][:30]
    summary = " \n ".join(summary_parts)[:12_000]
    conn.execute(
        """INSERT INTO channel_analysis(
             channel_id,category,is_marketplace,confidence,summary,tone,
             typical_content,why_recommended,activity_score,quality_score,
             freshness_score,final_score,analyzed_at)
           VALUES(%s,'news',false,1.0,%s,'informational','Public Telegram posts',
             'Collected from the public Telegram preview without MTProto',80,75,100,84,now())
           ON CONFLICT(channel_id) DO UPDATE SET
             category='news',confidence=1.0,summary=excluded.summary,tone=excluded.tone,
             typical_content=excluded.typical_content,why_recommended=excluded.why_recommended,
             activity_score=excluded.activity_score,quality_score=excluded.quality_score,
             freshness_score=excluded.freshness_score,final_score=excluded.final_score,
             analyzed_at=now()""",
        (channel_id, summary),
    )
    conn.execute(
        "UPDATE channels SET search_tsv=channels_build_tsv(%s) WHERE id=%s",
        (channel_id, channel_id),
    )
    return channel_id, inserted


def main() -> int:
    print(f"Collecting public Telegram previews: {', '.join('@'+x for x in CHANNELS)}")
    failures = 0
    with psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=False) as conn:
        for username in CHANNELS:
            try:
                parsed = parse_preview(username, fetch_preview(username))
                channel_id, inserted = store(conn, parsed)
                conn.commit()
                print(
                    f"OK @{username}: db_id={channel_id} title={parsed['title']!r} "
                    f"members={parsed['member_count']} posts={len(parsed['posts'])} new={inserted}"
                )
            except Exception as exc:
                conn.rollback()
                failures += 1
                print(f"WARN @{username}: {exc}", file=sys.stderr)
            time.sleep(1)

        total = conn.execute("SELECT COUNT(*) AS n FROM channels").fetchone()["n"]
        messages = conn.execute("SELECT COUNT(*) AS n FROM messages").fetchone()["n"]
        print(f"Database now contains channels={total} messages={messages}")
    return 0 if total > 0 else (1 if failures else 0)


if __name__ == "__main__":
    raise SystemExit(main())
