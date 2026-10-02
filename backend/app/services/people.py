"""Read models over players: profile, lobby roster, leaderboard and the admin overview."""

from __future__ import annotations

import time

from ..db import db
from ..errors import not_found
from ..schemas import (
    AdminOverview,
    LeaderboardEntry,
    LeaderboardResponse,
    LobbyPlayer,
    LobbyResponse,
    MeResponse,
)
from . import event as event_service
from .common import display_name, epoch_ms, format_hms, initials, player_code, summary

_LEADERBOARD_TTL_S = 2.0
_LOBBY_TTL_S = 2.0
_LOBBY_MAX = 1000
_leaderboard_cache: tuple[float, list[dict]] | None = None
_lobby_cache: tuple[float, LobbyResponse] | None = None


def invalidate_leaderboard() -> None:
    global _leaderboard_cache
    _leaderboard_cache = None


async def me(user_id: str, email: str | None) -> MeResponse:
    async with db.acquire() as conn:
        profile = await conn.fetchrow(
            "SELECT id, email, full_name, role::text AS role, player_no FROM public.profiles WHERE id = $1::uuid", user_id
        )
        if profile is None:
            raise not_found("Profile not found. Try signing out and in again.")
        part = await conn.fetchrow("SELECT * FROM public.participations WHERE user_id = $1::uuid", user_id)
    return MeResponse(
        id=str(profile["id"]),
        email=profile["email"] or email,
        full_name=display_name(profile["full_name"], profile["player_no"]),
        role=profile["role"],
        player_code=player_code(profile["player_no"]),
        participation=summary(part) if part else None,
    )


async def lobby() -> LobbyResponse:
    global _lobby_cache
    now = time.monotonic()
    if _lobby_cache and _lobby_cache[0] > now:
        return _lobby_cache[1]
    async with db.acquire() as conn:
        count = await conn.fetchval("SELECT count(*) FROM public.participations")
        rows = await conn.fetch(
            """
            SELECT p.full_name, p.player_no
            FROM public.participations pa JOIN public.profiles p ON p.id = pa.user_id
            ORDER BY pa.joined_at DESC
            LIMIT $1
            """,
            _LOBBY_MAX,
        )
    players = []
    for r in rows:
        name = display_name(r["full_name"], r["player_no"])
        players.append(LobbyPlayer(id=player_code(r["player_no"]), name=name, initials=initials(name)))
    _lobby_cache = (now + _LOBBY_TTL_S, LobbyResponse(count=count, players=players))
    return _lobby_cache[1]


async def _ranked() -> list[dict]:
    """Everyone who has started a round, best first. Cached briefly: it is the hottest read."""
    global _leaderboard_cache
    now = time.monotonic()
    if _leaderboard_cache and _leaderboard_cache[0] > now:
        return _leaderboard_cache[1]
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT row_number() OVER (ORDER BY pa.total_pts DESC, pa.total_time_ms ASC, pa.joined_at ASC) AS rank,
                   pa.user_id::text AS user_id, p.full_name, p.player_no,
                   pa.round_pts, pa.bonus_pts, pa.total_pts, pa.total_time_ms
            FROM public.participations pa JOIN public.profiles p ON p.id = pa.user_id
            WHERE pa.status <> 'joined'
            ORDER BY rank
            """
        )
    ranked = [dict(r) for r in rows]
    _leaderboard_cache = (now + _LEADERBOARD_TTL_S, ranked)
    return ranked


async def leaderboard(viewer_id: str | None, limit: int | None) -> LeaderboardResponse:
    ranked = await _ranked()
    ev = await event_service.get_event()
    chosen = ranked if limit is None else ranked[:limit]
    entries = []
    for r in chosen:
        name = display_name(r["full_name"], r["player_no"])
        entries.append(
            LeaderboardEntry(
                rank=r["rank"],
                id=player_code(r["player_no"]),
                name=name,
                initials=initials(name),
                round_pts=r["round_pts"],
                bonus=r["bonus_pts"],
                total=r["total_pts"],
                time=format_hms(r["total_time_ms"]),
                self=viewer_id is not None and r["user_id"] == viewer_id,
            )
        )
    return LeaderboardResponse(entries=entries, total=len(ranked), event_status=ev["status"])


async def admin_overview() -> AdminOverview:
    ev = await event_service.get_event(fresh=True)
    async with db.acquire() as conn:
        counts = await conn.fetchrow(
            """
            SELECT count(*) AS players,
                   count(*) FILTER (WHERE status = 'playing') AS playing,
                   count(*) FILTER (WHERE status = 'finished') AS finished
            FROM public.participations
            """
        )
        alerts = await conn.fetchrow(
            """
            SELECT count(*) FILTER (WHERE NOT acknowledged) AS open,
                   count(*) FILTER (WHERE NOT acknowledged AND severity = 'high') AS high_open
            FROM public.proctor_events WHERE NOT dismissed
            """
        )
    return AdminOverview(
        status=ev["status"],
        started_at=epoch_ms(ev["started_at"]),
        ended_at=epoch_ms(ev["ended_at"]),
        server_time=int(time.time() * 1000),
        players=counts["players"],
        playing=counts["playing"],
        finished=counts["finished"],
        open_alerts=alerts["open"],
        high_open_alerts=alerts["high_open"],
    )
