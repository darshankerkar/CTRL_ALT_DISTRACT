"""The round engine. The server owns the clock, the scores and the round order.

Timing model (all instants are Postgres `now()`, so worker clocks never matter):

    elapsed time = now - started_at - paused_ms - open distraction/suspension time

Coding rounds have no deadline. Active elapsed time is recorded for leaderboard ties and used to
schedule distractions. A distraction pauses that elapsed time (`pause_started_at`), and the client
receives `elapsedSeconds` on every sync so refreshes and second tabs agree with the server.

Arena transitions share-lock the event row before locking the player's `participations` row,
so admin completion, double-clicks and parallel tabs cannot deadlock or double-award points.
"""

from __future__ import annotations

import random
import time

import asyncpg

from ..config import get_settings
from ..db import db
from ..errors import ApiError, conflict, not_found
from ..judge.evaluate import Evaluation
from ..judge.service import judge, judge_io
from ..schemas import (
    ArenaState,
    CaseOut,
    CodeRequest,
    CompileOut,
    DistractionResolveRequest,
    DistractionResolveResponse,
    DistractionStatus,
    ProblemPublic,
    QuestionItem,
    QuestionsResponse,
    ResultsResponse,
    RoundInfo,
    RoundResult,
    RunResponse,
    SubmitResponse,
)
from . import catalog, people, proctor
from . import event as event_service
from .common import display_name, format_hms, summary
from .limits import gate

# Size of the frontend's distraction registry (src/utils/distractionRegistry.ts).
DISTRACTION_COUNT = 10
# Two sessions on one account within this window are reported as MULTI_SESSION.
SESSION_WINDOW_S = 20

_judge_client = None


def set_judge_client(client) -> None:
    global _judge_client
    _judge_client = client


# --------------------------------------------------------------------------- low-level helpers


def _ms_between(later, earlier) -> float:
    return (later - earlier).total_seconds() * 1000


def elapsed_ms(attempt: asyncpg.Record, now) -> int:
    """Active milliseconds on this question, excluding games and other questions."""
    if attempt["resolved_at"] and attempt.get("time_ms") is not None:
        return max(0, int(attempt["time_ms"]))
    end = attempt["resolved_at"] or now
    used = _ms_between(end, attempt["started_at"]) - attempt["paused_ms"]
    if attempt["pause_started_at"] and not attempt["resolved_at"]:
        used -= _ms_between(now, attempt["pause_started_at"])
    if attempt.get("suspended_at") and not attempt["resolved_at"]:
        used -= _ms_between(now, attempt["suspended_at"])
    return max(0, int(used))


async def _lock_participation(conn: asyncpg.Connection, user_id: str) -> asyncpg.Record:
    row = await conn.fetchrow(
        "SELECT *, now() AS db_now FROM public.participations WHERE user_id = $1::uuid FOR UPDATE", user_id
    )
    if row is None:
        raise conflict("not_joined", "You have not joined the event.")
    return row


async def _participation(conn: asyncpg.Connection, user_id: str) -> asyncpg.Record:
    return await conn.fetchrow("SELECT * FROM public.participations WHERE user_id = $1::uuid", user_id)


async def _attempt(conn: asyncpg.Connection, user_id: str, round_no: int) -> asyncpg.Record | None:
    if round_no <= 0:
        return None
    return await conn.fetchrow(
        "SELECT * FROM public.round_attempts WHERE user_id = $1::uuid AND round_no = $2", user_id, round_no
    )


# --------------------------------------------------------------------------- state transitions


async def _resolve_round(
    conn: asyncpg.Connection,
    ev: asyncpg.Record,
    user_id: str,
    round_no: int,
    *,
    status: str,
    time_ms: int,
    points: int,
) -> asyncpg.Record | None:
    """Close an active round exactly once and roll the result into the participant's totals."""
    part = await _participation(conn, user_id)
    finished = status == "solved" and part["solved_count"] + 1 >= ev["total_rounds"]
    row = await conn.fetchrow(
        """
        UPDATE public.round_attempts
        SET status = $3::round_status, resolved_at = now(), time_ms = $4, points = $5,
            paused_ms = paused_ms
                + COALESCE(GREATEST(0, (EXTRACT(EPOCH FROM (now() - pause_started_at)) * 1000)::int), 0)
                + COALESCE(GREATEST(0, (EXTRACT(EPOCH FROM (now() - suspended_at)) * 1000)::int), 0),
            distraction_state = CASE WHEN distraction_state IN ('pending', 'active') THEN 'missed' ELSE distraction_state END,
            pause_started_at = NULL, suspended_at = NULL, submit_lock_until = NULL
        WHERE user_id = $1::uuid AND round_no = $2 AND status = 'active'
        RETURNING *
        """,
        user_id, round_no, status, time_ms, points,
    )
    if row is None:
        return None
    await conn.execute(
        """
        UPDATE public.participations
        SET round_pts = round_pts + $2,
            solved_count = solved_count + $3,
            total_time_ms = total_time_ms + $4,
            status = CASE WHEN $5 THEN 'finished'::participant_status ELSE status END,
            finished_at = CASE WHEN $5 THEN now() ELSE finished_at END
        WHERE user_id = $1::uuid
        """,
        user_id, points, 1 if status == "solved" else 0, time_ms, finished,
    )
    return row


async def _activate_question(
    conn: asyncpg.Connection, ev: asyncpg.Record, part: asyncpg.Record, round_no: int
) -> tuple[asyncpg.Record, asyncpg.Record]:
    """Select one assigned question without discarding its attempt or random schedule."""
    user_id = str(part["user_id"])
    attempt = await _attempt(conn, user_id, round_no)
    if attempt is not None and attempt["status"] != "active":
        raise conflict("already_solved", "That question is already complete.")
    if attempt is None:
        problem = await catalog.get_problem(part["problem_order"][round_no - 1])
        order = part["distraction_order"]
        lo = ev["distraction_min_at"]
        hi = max(lo, ev["distraction_max_at"])
        attempt = await conn.fetchrow(
            """
            INSERT INTO public.round_attempts
                (user_id, round_no, problem_id, distraction_index, distraction_at)
            VALUES ($1::uuid, $2, $3, $4, $5) RETURNING *
            """,
            user_id, round_no, problem.id, order[(round_no - 1) % len(order)], random.randint(lo, hi),
        )
    elif attempt.get("suspended_at") is not None:
        attempt = await conn.fetchrow(
            """
            UPDATE public.round_attempts
            SET paused_ms = paused_ms + GREATEST(0, (EXTRACT(EPOCH FROM (now() - suspended_at)) * 1000)::int),
                suspended_at = NULL
            WHERE user_id = $1::uuid AND round_no = $2 AND status = 'active' RETURNING *
            """,
            user_id, round_no,
        )
    await conn.execute(
        "UPDATE public.participations SET current_round = $2, status = 'playing', "
        "started_at = COALESCE(started_at, now()) WHERE user_id = $1::uuid",
        user_id, round_no,
    )
    return await _participation(conn, user_id), attempt


def _validate_question(ev: asyncpg.Record, part: asyncpg.Record, round_no: int) -> None:
    if round_no < 1 or round_no > ev["total_rounds"] or round_no > len(part["problem_order"]):
        raise ApiError(403, "locked_round", "That question is not assigned to you.")


async def _settle(
    conn: asyncpg.Connection, ev: asyncpg.Record, part: asyncpg.Record, now
) -> tuple[asyncpg.Record, asyncpg.Record | None]:
    """Time out abandoned distractions while leaving coding rounds open."""
    user_id = str(part["user_id"])
    attempt = await _attempt(conn, user_id, part["current_round"])
    if attempt is None or attempt["status"] != "active":
        return part, attempt

    cap_ms = (ev["distraction_seconds"] + ev["distraction_grace_seconds"]) * 1000

    if attempt["pause_started_at"] and _ms_between(now, attempt["pause_started_at"]) > cap_ms:
        attempt = await conn.fetchrow(
            """
            UPDATE public.round_attempts
            SET paused_ms = paused_ms + $3, pause_started_at = NULL, distraction_state = 'missed'
            WHERE user_id = $1::uuid AND round_no = $2 RETURNING *
            """,
            user_id, attempt["round_no"], cap_ms,
        )
        await conn.execute(
            "INSERT INTO public.distraction_events (user_id, round_no, distraction_index, result, time_taken) "
            "VALUES ($1::uuid, $2, $3, 'timeout', $4)",
            user_id, attempt["round_no"], attempt["distraction_index"], ev["distraction_seconds"],
        )

    return part, attempt


async def _touch_session(
    conn: asyncpg.Connection, ev: asyncpg.Record, part: asyncpg.Record, client: str | None, now
) -> None:
    """Track which tab owns the run; a second live tab on the same account raises an alert."""
    if not client or part["status"] != "playing" or ev["status"] != "live":
        return
    user_id = str(part["user_id"])
    seen = part["last_seen_at"]
    stale = seen is None or _ms_between(now, seen) > SESSION_WINDOW_S * 1000
    if part["active_client"] != client:
        if part["active_client"] and not stale:
            await proctor.record(conn, user_id, "MULTI_SESSION", part["current_round"], dedupe_s=60)
        await conn.execute(
            "UPDATE public.participations SET active_client = $2, last_seen_at = now() WHERE user_id = $1::uuid",
            user_id, client,
        )
    elif seen is None or _ms_between(now, seen) > 10_000:
        await conn.execute("UPDATE public.participations SET last_seen_at = now() WHERE user_id = $1::uuid", user_id)


async def _build_state(
    conn: asyncpg.Connection, ev: asyncpg.Record, part: asyncpg.Record, attempt: asyncpg.Record | None, now
) -> ArenaState:
    user_id = str(part["user_id"])
    done = await conn.fetch(
        "SELECT round_no, status::text AS status FROM public.round_attempts "
        "WHERE user_id = $1::uuid AND status <> 'active' ORDER BY round_no",
        user_id,
    )
    info: RoundInfo | None = None
    if attempt is not None:
        remaining = None
        if attempt["pause_started_at"]:
            cap = ev["distraction_seconds"] * 1000
            remaining = max(0, int((cap - _ms_between(now, attempt["pause_started_at"])) // 1000))
        info = RoundInfo(
            round=attempt["round_no"],
            status=attempt["status"],
            elapsed_seconds=elapsed_ms(attempt, now) // 1000,
            distraction=DistractionStatus(
                state=attempt["distraction_state"],
                at_seconds=attempt["distraction_at"],
                index=attempt["distraction_index"],
                remaining_seconds=remaining,
            ),
        )
    return ArenaState(
        event_status=ev["status"],
        finished=part["status"] == "finished",
        participant=summary(part),
        rounds=[RoundResult(round=r["round_no"], status=r["status"]) for r in done],
        round=info,
        server_time=int(time.time() * 1000),
    )


# --------------------------------------------------------------------------- public operations


async def join(user_id: str) -> None:
    ev = await event_service.get_event()
    if ev["status"] == "ended":
        raise conflict("event_ended", "The event has ended.")
    pool = await catalog.pool_ids()
    if len(pool) < ev["total_rounds"]:
        raise conflict(
            "problems_missing", f"Only {len(pool)} questions are loaded but {ev['total_rounds']} rounds are configured."
        )
    order = random.sample(range(1, DISTRACTION_COUNT + 1), DISTRACTION_COUNT)
    questions = random.sample(pool, ev["total_rounds"])  # this player's questions, in play order
    async with db.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.participations (user_id, distraction_order, problem_order) VALUES ($1::uuid, $2, $3) "
            "ON CONFLICT (user_id) DO NOTHING",
            user_id, order, questions,
        )


async def leave(user_id: str) -> None:
    """Leave the lobby. Only allowed before the player has started a round."""
    async with db.transaction() as conn:
        part = await _lock_participation(conn, user_id)
        if part["current_round"] > 0:
            raise conflict("already_started", "You cannot leave once the event has started for you.")
        await conn.execute("DELETE FROM public.participations WHERE user_id = $1::uuid", user_id)


async def exit_challenge(user_id: str) -> ArenaState:
    """Finish this player's run, retaining earned points, submissions and leaderboard eligibility."""
    async with db.transaction() as conn:
        # Event lifecycle operations lock this row first. Match that order so an admin ending
        # the event and a participant exiting cannot deadlock while closing the same round.
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        if part["current_round"] <= 0:
            raise conflict("not_started", "You have not started the challenge yet.")
        part, attempt = await _settle(conn, ev, part, now)

        if part["status"] != "finished":
            open_attempts = await conn.fetch(
                "SELECT * FROM public.round_attempts WHERE user_id = $1::uuid AND status = 'active' ORDER BY round_no",
                user_id,
            )
            for open_attempt in open_attempts:
                used_ms = elapsed_ms(open_attempt, now)
                paused_ms = int(_ms_between(now, open_attempt["pause_started_at"])) if open_attempt["pause_started_at"] else 0
                # Close and clear suspension together in _resolve_round. Clearing a suspended
                # active row first would violate the one-selected-question unique index.
                if open_attempt["distraction_state"] == "active":
                    await conn.execute(
                        "INSERT INTO public.distraction_events "
                        "(user_id, round_no, distraction_index, result, time_taken, metrics) "
                        "VALUES ($1::uuid, $2, $3, 'timeout', $4, $5)",
                        user_id, open_attempt["round_no"], open_attempt["distraction_index"],
                        min(ev["distraction_seconds"], max(0, paused_ms // 1000)), {"reason": "participant_exit"},
                    )
                await _resolve_round(
                    conn, ev, user_id, open_attempt["round_no"], status="expired", time_ms=used_ms, points=0,
                )

            await conn.execute(
                "UPDATE public.participations SET status = 'finished', "
                "finished_at = COALESCE(finished_at, now()) WHERE user_id = $1::uuid",
                user_id,
            )
            part = await _participation(conn, user_id)
            attempt = await _attempt(conn, user_id, part["current_round"])
        state = await _build_state(conn, ev, part, attempt, now)

    people.invalidate_leaderboard()
    return state


async def get_state(user_id: str, client: str | None = None) -> ArenaState:
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        await _touch_session(conn, ev, part, client, now)
        part, attempt = await _settle(conn, ev, part, now)
        return await _build_state(conn, ev, part, attempt, now)


async def start_or_advance(user_id: str, client: str | None = None) -> ArenaState:
    """Resume the selected question, or begin the first remaining unsolved question."""
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        if ev["status"] != "live":
            raise conflict("event_not_live", "The event has not started yet." if ev["status"] == "lobby" else "The event has ended.")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        await _touch_session(conn, ev, part, client, now)
        part, attempt = await _settle(conn, ev, part, now)

        if part["status"] != "finished" and (attempt is None or attempt["status"] != "active" or attempt.get("suspended_at")):
            completed = {
                row["round_no"] for row in await conn.fetch(
                    "SELECT round_no FROM public.round_attempts WHERE user_id = $1::uuid AND status <> 'active'", user_id,
                )
            }
            next_round = next((number for number in range(1, ev["total_rounds"] + 1) if number not in completed), None)
            if next_round is not None:
                _validate_question(ev, part, next_round)
                part, attempt = await _activate_question(conn, ev, part, next_round)
        return await _build_state(conn, ev, part, attempt, now)


async def questions(user_id: str) -> QuestionsResponse:
    """Public summaries for this player's stable question assignment; never hidden tests."""
    async with db.acquire() as conn:
        ev = await event_service.get_event(conn, fresh=True)
        part = await _participation(conn, user_id)
        if part is None:
            raise conflict("not_joined", "Join the event to view your questions.")
        if ev["status"] == "lobby":
            raise conflict("event_not_live", "Questions are available when the event starts.")
        attempts = {row["round_no"]: row for row in await conn.fetch(
            "SELECT round_no, status::text AS status FROM public.round_attempts WHERE user_id = $1::uuid ORDER BY round_no",
            user_id,
        )}
    items = []
    for number, problem_id in enumerate(part["problem_order"][:ev["total_rounds"]], start=1):
        problem = (await catalog.get_problem(problem_id)).public
        attempt = attempts.get(number)
        solved = attempt is not None and attempt["status"] == "solved"
        items.append(QuestionItem(
            round=number, title=problem.title, difficulty=problem.difficulty, points=ev["dsa_points"],
            status="solved" if solved else "unsolved",
            description=next((paragraph for paragraph in problem.description if paragraph.strip()), ""),
            in_progress=attempt is not None and attempt["status"] == "active",
        ))
    return QuestionsResponse(items=items, participant=summary(part), event_status=ev["status"], finished=part["status"] == "finished")


async def select_question(user_id: str, round_no: int, client: str | None = None) -> ArenaState:
    """Switch to any assigned unfinished question, preserving work and elapsed time."""
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        if ev["status"] != "live":
            raise conflict("event_not_live", "The event is not live.")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        if part["status"] == "finished":
            raise conflict("participant_finished", "Your participation is complete.")
        _validate_question(ev, part, round_no)
        await _touch_session(conn, ev, part, client, now)
        part, current = await _settle(conn, ev, part, now)
        wanted = await _attempt(conn, user_id, round_no)
        if wanted is not None and wanted["status"] != "active":
            raise conflict("already_solved", "That question is already complete.")
        if current is not None and current["status"] == "active" and current["round_no"] != round_no:
            if current["distraction_state"] == "active":
                raise conflict("distraction_active", "Finish the distraction before switching questions.")
            if current["distraction_state"] == "pending" and elapsed_ms(current, now) >= current["distraction_at"] * 1000:
                raise conflict("distraction_due", "Complete the scheduled distraction before switching questions.")
            await conn.execute(
                "UPDATE public.round_attempts SET suspended_at = now() "
                "WHERE user_id = $1::uuid AND round_no = $2 AND status = 'active' AND suspended_at IS NULL",
                user_id, current["round_no"],
            )
        part, attempt = await _activate_question(conn, ev, part, round_no)
        return await _build_state(conn, ev, part, attempt, now)


async def current_problem(user_id: str, round_no: int | None) -> ProblemPublic:
    async with db.acquire() as conn:
        ev = await event_service.get_event(conn, fresh=True)
        part = await _participation(conn, user_id)
    if part is None:
        raise conflict("not_joined", "Join the event to view your questions.")
    if ev["status"] == "lobby":
        raise conflict("event_not_live", "Questions are available when the event starts.")
    if round_no is None and part["current_round"] == 0:
        raise conflict("not_started", "No round is in progress.")
    wanted = part["current_round"] if round_no is None else round_no
    _validate_question(ev, part, wanted)
    return catalog.public_for_round(await catalog.get_problem(part["problem_order"][wanted - 1]), wanted)


async def distraction_start(user_id: str, round_no: int | None = None) -> ArenaState:
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        if round_no is not None and round_no != part["current_round"]:
            raise conflict("question_changed", "The selected question changed. Refresh the arena.")
        part, attempt = await _settle(conn, ev, part, now)
        if ev["status"] != "live" or part["status"] == "finished" or attempt is None or attempt["status"] != "active" or attempt.get("suspended_at"):
            raise conflict("round_closed", "There is no active round.")
        if attempt["distraction_state"] == "active":
            return await _build_state(conn, ev, part, attempt, now)  # idempotent
        if attempt["distraction_state"] != "pending":
            raise conflict("distraction_done", "This round's distraction is already over.")
        if elapsed_ms(attempt, now) < attempt["distraction_at"] * 1000 - 5000:
            raise conflict("too_early", "The distraction is not due yet.")
        attempt = await conn.fetchrow(
            "UPDATE public.round_attempts SET pause_started_at = now(), distraction_state = 'active' "
            "WHERE user_id = $1::uuid AND round_no = $2 RETURNING *",
            user_id, attempt["round_no"],
        )
        await conn.execute(
            "UPDATE public.participations SET distractions_total = distractions_total + 1 WHERE user_id = $1::uuid", user_id
        )
        part = await _participation(conn, user_id)
        return await _build_state(conn, ev, part, attempt, now)


async def distraction_resolve(user_id: str, req: DistractionResolveRequest) -> DistractionResolveResponse:
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        if req.round is not None and req.round != part["current_round"]:
            raise conflict("question_changed", "The selected question changed. Refresh the arena.")
        part, attempt = await _settle(conn, ev, part, now)
        if attempt is None:
            raise conflict("round_closed", "There is no active round.")
        if part["status"] == "finished" or attempt["status"] != "active" or attempt["distraction_state"] != "active":
            # A late result cannot award a bonus after this player has exited or their round closed.
            cleared = attempt["distraction_state"] == "cleared"
            return DistractionResolveResponse(cleared=cleared, bonus=attempt["bonus"], participant=summary(part))

        window_ms = (ev["distraction_seconds"] + ev["distraction_grace_seconds"]) * 1000
        paused_for = _ms_between(now, attempt["pause_started_at"])
        in_time = paused_for <= window_ms and req.time_taken <= ev["distraction_seconds"] + ev["distraction_grace_seconds"]
        cleared = req.result == "passed" and in_time and req.time_taken >= 1
        bonus = ev["bonus_points"] if cleared else 0

        await conn.execute(
            """
            UPDATE public.round_attempts
            SET paused_ms = paused_ms + $3, pause_started_at = NULL, bonus = $4, distraction_state = $5
            WHERE user_id = $1::uuid AND round_no = $2
            """,
            user_id, attempt["round_no"], int(min(paused_for, window_ms)), bonus, "cleared" if cleared else "missed",
        )
        await conn.execute(
            "INSERT INTO public.distraction_events "
            "(user_id, round_no, distraction_index, distraction_id, result, time_taken, bonus, metrics) "
            "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)",
            user_id, attempt["round_no"], attempt["distraction_index"], req.distraction_id,
            req.result if in_time else "timeout", req.time_taken, bonus, req.metrics,
        )
        if cleared:
            await conn.execute(
                "UPDATE public.participations SET bonus_pts = bonus_pts + $2, "
                "distractions_cleared = distractions_cleared + 1 WHERE user_id = $1::uuid",
                user_id, bonus,
            )
        part = await _participation(conn, user_id)
        return DistractionResolveResponse(cleared=cleared, bonus=bonus, participant=summary(part))


# --------------------------------------------------------------------------- run / submit


def _case_out(index: int, test: asyncpg.Record, outcome) -> CaseOut:
    return CaseOut(
        index=index,
        input=test["display_input"] or "",
        expected=test["display_expected"] or "",
        actual=outcome.actual,
        status=outcome.status,
        message=outcome.message,
    )


def _compile_out(ev: Evaluation) -> CompileOut | None:
    return CompileOut(message=ev.compile.message, line=ev.compile.line, file=ev.compile.file) if ev.compile else None


async def _validate_code(req: CodeRequest) -> None:
    if len(req.code.encode()) > get_settings().max_code_bytes:
        raise ApiError(413, "code_too_large", "Your code is too large to run.")
    if not req.code.strip():
        raise ApiError(400, "empty_code", "Write some code first.")


async def _open_round(user_id: str, round_no: int | None = None) -> tuple[asyncpg.Record, asyncpg.Record, int]:
    """Validate that the player has an active, un-paused round. Returns (event, attempt, elapsed_ms)."""
    async with db.transaction() as conn:
        ev = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        now = part["db_now"]
        if round_no is not None and round_no != part["current_round"]:
            raise conflict("question_changed", "The selected question changed. Refresh the arena before submitting.")
        part, attempt = await _settle(conn, ev, part, now)
        if ev["status"] != "live":
            raise conflict("event_not_live", "The event is not live.")
        if part["status"] == "finished" or attempt is None or attempt["status"] != "active" or attempt.get("suspended_at"):
            raise conflict("round_closed", "This round is already over.")
        if attempt["distraction_state"] == "active":
            raise conflict("distraction_active", "Finish the distraction first.")
        used = elapsed_ms(attempt, now)
        return ev, attempt, used


async def _judge(attempt: asyncpg.Record, req: CodeRequest, *, samples_only: bool):
    problem = await catalog.get_problem(attempt["problem_id"])
    language = await catalog.get_language(req.language)
    tests = await catalog.get_tests(problem.id, samples_only=samples_only)
    if not tests:
        raise ApiError(500, "tests_missing", "No test cases are configured for this problem.")
    cases = [case for _, case in tests]
    if problem.mode == "io":
        evaluation = await judge_io(
            _judge_client,
            language=language,
            time_limit_ms=problem.row["time_limit_ms"],
            memory_limit_kb=problem.row["memory_limit_kb"],
            cases=cases,
            code=req.code,
        )
    else:
        evaluation = await judge(
            _judge_client,
            language=language,
            signature=problem.signature,
            time_limit_ms=problem.row["time_limit_ms"],
            memory_limit_kb=problem.row["memory_limit_kb"],
            cases=cases,
            code=req.code,
        )
    return problem, tests, evaluation


async def _log_submission(user_id: str, problem_id: int, round_no: int, req: CodeRequest, kind: str, verdict: str, ev: Evaluation) -> None:
    detail = ev.compile.message[:1000] if ev.compile else next((c.message for c in ev.cases if c.message), None)
    async with db.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.submissions "
            "(user_id, problem_id, round_no, language, kind, code, verdict, passed, total, runtime_ms, memory_kb, detail) "
            "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            user_id, problem_id, round_no, req.language, kind, req.code, verdict, ev.passed, ev.total,
            ev.time_ms, ev.memory_kb, detail,
        )


async def run(user_id: str, req: CodeRequest) -> RunResponse:
    """Run against the sample cases only. Shows the player real inputs, expectations and outputs."""
    await _validate_code(req)
    settings = get_settings()
    async with gate.guard(user_id, settings.run_interval_s):
        _, attempt, _ = await _open_round(user_id, req.round)
        problem, tests, evaluation = await _judge(attempt, req, samples_only=True)
    result = "compile-error" if evaluation.compile else "passed" if evaluation.all_passed else "failed"
    await _log_submission(user_id, problem.id, attempt["round_no"], req, "run", result, evaluation)
    return RunResponse(
        round=attempt["round_no"],
        result=result,
        passed=evaluation.passed,
        total=evaluation.total,
        cases=[_case_out(i, row, outcome) for i, ((row, _), outcome) in enumerate(zip(tests, evaluation.cases))],
        compile=_compile_out(evaluation),
        runtime_ms=evaluation.time_ms,
        memory_kb=evaluation.memory_kb,
    )


async def submit(user_id: str, req: CodeRequest) -> SubmitResponse:
    """Judge against every test case. A fully accepted submission scores the round exactly once."""
    await _validate_code(req)
    settings = get_settings()
    async with gate.guard(user_id, settings.submit_interval_s):
        ev, attempt, used_ms = await _open_round(user_id, req.round)
        round_no = attempt["round_no"]
        problem, _, evaluation = await _judge(attempt, req, samples_only=False)

    verdict = "compile-error" if evaluation.compile else "accepted" if evaluation.all_passed else "wrong"
    async with db.transaction() as conn:
        live_event = await conn.fetchrow("SELECT * FROM public.event_config FOR SHARE")
        part = await _lock_participation(conn, user_id)
        current = await _attempt(conn, user_id, round_no)
        scored = False
        if verdict == "accepted" and live_event["status"] == "live" and part["status"] != "finished" and current is not None and current["status"] == "active":
            scored = (
                await _resolve_round(
                    conn, ev, user_id, round_no, status="solved", time_ms=used_ms, points=ev["dsa_points"]
                )
                is not None
            )
        part = await _participation(conn, user_id)

    await _log_submission(user_id, problem.id, round_no, req, "submit", verdict, evaluation)
    if scored:
        people.invalidate_leaderboard()
    closed_early = verdict == "accepted" and not scored  # the round ended (e.g. admin stopped the event) mid-judging
    return SubmitResponse(
        round=round_no,
        result="expired" if closed_early else verdict,
        headline="ROUND CLOSED" if closed_early else evaluation.headline(),
        passed=evaluation.passed,
        total=evaluation.total,
        compile=_compile_out(evaluation),
        runtime_ms=evaluation.time_ms,
        memory_kb=evaluation.memory_kb,
        participant=summary(part),
    )


# --------------------------------------------------------------------------- results


async def results(user_id: str) -> ResultsResponse:
    async with db.acquire() as conn:
        part = await _participation(conn, user_id)
        if part is None:
            raise not_found("You have no results yet.")
        profile = await conn.fetchrow("SELECT full_name, player_no FROM public.profiles WHERE id = $1::uuid", user_id)
        ev = await event_service.get_event(conn)
        solved = {
            r["round_no"]
            for r in await conn.fetch(
                "SELECT round_no FROM public.round_attempts WHERE user_id = $1::uuid AND status = 'solved'", user_id
            )
        }
    return ResultsResponse(
        full_name=display_name(profile["full_name"], profile["player_no"]),
        total=part["total_pts"],
        round_pts=part["round_pts"],
        bonus=part["bonus_pts"],
        solved=part["solved_count"],
        time_taken=format_hms(part["total_time_ms"]),
        distractions_cleared=part["distractions_cleared"],
        distractions_total=part["distractions_total"],
        rounds=[1 if n in solved else 0 for n in range(1, ev["total_rounds"] + 1)],
    )
