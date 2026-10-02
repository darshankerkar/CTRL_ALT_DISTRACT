"""Event configuration and lifecycle (lobby -> live -> ended)."""

from __future__ import annotations

import time
from zoneinfo import ZoneInfo

import asyncpg

from ..db import db
from ..errors import conflict
from ..schemas import EventInfo, LanguageInfo
from .common import epoch_ms

_EVENT_TTL_S = 1.0
_LANG_TTL_S = 60.0
_event_cache: tuple[float, asyncpg.Record] | None = None
_lang_cache: tuple[float, list[asyncpg.Record]] | None = None


def invalidate() -> None:
    global _event_cache
    _event_cache = None


async def get_event(conn: asyncpg.Connection | None = None, *, fresh: bool = False) -> asyncpg.Record:
    """The singleton event row. Cached for a second so polling clients don't each hit Postgres."""
    global _event_cache
    now = time.monotonic()
    if not fresh and _event_cache and _event_cache[0] > now:
        return _event_cache[1]
    if conn is None:
        async with db.acquire() as c:
            row = await c.fetchrow("SELECT * FROM public.event_config")
    else:
        row = await conn.fetchrow("SELECT * FROM public.event_config")
    _event_cache = (now + _EVENT_TTL_S, row)
    return row


async def get_languages(conn: asyncpg.Connection | None = None) -> list[asyncpg.Record]:
    global _lang_cache
    now = time.monotonic()
    if _lang_cache and _lang_cache[0] > now:
        return _lang_cache[1]
    sql = "SELECT * FROM public.languages WHERE enabled ORDER BY ord"
    if conn is None:
        async with db.acquire() as c:
            rows = await c.fetch(sql)
    else:
        rows = await conn.fetch(sql)
    _lang_cache = (now + _LANG_TTL_S, rows)
    return rows


def _labels(ev: asyncpg.Record) -> tuple[str, str]:
    local = ev["scheduled_at"].astimezone(ZoneInfo(ev["timezone"]))
    return local.strftime("%d %b %Y").upper(), f"{local:%H:%M} {ev['timezone_label']}"


async def event_info(conn: asyncpg.Connection | None = None) -> EventInfo:
    ev = await get_event(conn)
    langs = await get_languages(conn)
    date_label, time_label = _labels(ev)
    return EventInfo(
        status=ev["status"],
        started_at=epoch_ms(ev["started_at"]),
        ended_at=epoch_ms(ev["ended_at"]),
        server_time=int(time.time() * 1000),
        name=ev["name"],
        organizer_name=ev["organizer_name"],
        college_name=ev["college_name"],
        event_date=date_label,
        event_time=time_label,
        total_rounds=ev["total_rounds"],
        round_seconds=None,
        round_minutes=None,
        dsa_points=ev["dsa_points"],
        bonus_points=ev["bonus_points"],
        distraction_seconds=ev["distraction_seconds"],
        languages=[LanguageInfo(id=r["id"], label=r["label"], file=r["filename"]) for r in langs],
    )


# --------------------------------------------------------------------------- admin transitions


async def start_event() -> None:
    async with db.transaction() as conn:
        row = await conn.fetchrow("SELECT status FROM public.event_config FOR UPDATE")
        if row["status"] != "lobby":
            raise conflict("bad_transition", f"Event is {row['status']}; it can only be started from the lobby.")
        problems = await conn.fetchval("SELECT count(*) FROM public.problems WHERE is_active")
        total_rounds = await conn.fetchval("SELECT total_rounds FROM public.event_config")
        if problems < total_rounds:
            raise conflict("problems_missing", f"{problems} active problems loaded but {total_rounds} rounds configured.")
        await conn.execute(
            "UPDATE public.event_config SET status='live', started_at=now(), ended_at=NULL, updated_at=now()"
        )
    invalidate()


async def end_event() -> None:
    async with db.transaction() as conn:
        row = await conn.fetchrow("SELECT status FROM public.event_config FOR UPDATE")
        if row["status"] != "live":
            raise conflict("bad_transition", f"Event is {row['status']}; only a live event can be ended.")
        await conn.execute("UPDATE public.event_config SET status='ended', ended_at=now(), updated_at=now()")
        await finalize_all(conn)
    invalidate()


async def reset_event() -> None:
    """Wipe all run data and reopen the lobby. Only allowed once the event has ended."""
    async with db.transaction() as conn:
        row = await conn.fetchrow("SELECT status FROM public.event_config FOR UPDATE")
        if row["status"] != "ended":
            raise conflict("bad_transition", "Only an ended event can be reset.")
        for table in ("proctor_events", "distraction_events", "submissions", "round_attempts", "participations"):
            await conn.execute(f"DELETE FROM public.{table}")
        await conn.execute(
            "UPDATE public.event_config SET status='lobby', started_at=NULL, ended_at=NULL, updated_at=now()"
        )
    invalidate()


async def finalize_all(conn: asyncpg.Connection) -> None:
    """Close every still-open round and mark every participant finished (used when the event ends)."""
    closed = await conn.fetch(
        """
        WITH closing AS (
            UPDATE public.round_attempts ra
            SET status = 'expired', resolved_at = now(),
                pause_started_at = NULL, suspended_at = NULL, submit_lock_until = NULL,
                distraction_state = CASE WHEN distraction_state IN ('pending', 'active') THEN 'missed' ELSE distraction_state END,
                paused_ms = paused_ms
                    + COALESCE((EXTRACT(EPOCH FROM (now() - pause_started_at)) * 1000)::int, 0)
                    + COALESCE((EXTRACT(EPOCH FROM (now() - suspended_at)) * 1000)::int, 0),
                time_ms = GREATEST(0, (
                    EXTRACT(EPOCH FROM (now() - ra.started_at)) * 1000
                    - ra.paused_ms
                    - COALESCE(EXTRACT(EPOCH FROM (now() - ra.pause_started_at)) * 1000, 0)
                    - COALESCE(EXTRACT(EPOCH FROM (now() - ra.suspended_at)) * 1000, 0)
                )::int)
            WHERE ra.status = 'active'
            RETURNING ra.user_id, ra.time_ms
        )
        SELECT user_id, time_ms FROM closing
        """
    )
    for r in closed:
        await conn.execute(
            "UPDATE public.participations SET total_time_ms = total_time_ms + $2 WHERE user_id = $1",
            r["user_id"], r["time_ms"],
        )
    await conn.execute(
        "UPDATE public.participations SET status='finished', finished_at=COALESCE(finished_at, now()) "
        "WHERE status <> 'finished' AND current_round > 0"
    )
