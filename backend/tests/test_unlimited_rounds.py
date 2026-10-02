"""Coding rounds have no deadline; ranking still records active solving time.

All database and judge calls are local fakes. These tests never connect to Supabase.
"""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.errors import ApiError
from app.judge.evaluate import CaseOutcome, CompileInfo, Evaluation
from app.schemas import CodeRequest
from app.services import arena, event


USER_ID = "00000000-0000-0000-0000-000000000001"
NOW = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
USED_MS = 1_500_123  # 25 minutes, beyond the old 10-minute coding deadline.


class RoundDatabase:
    """A single participant with transaction serialization and conditional resolution."""

    def __init__(self):
        self.now = NOW
        self.lock = asyncio.Lock()
        self.statements = []
        self.distraction_events = []
        self.ev = {
            "status": "live", "total_rounds": 10, "round_seconds": 600,
            "distraction_seconds": 30, "distraction_grace_seconds": 5,
            "dsa_points": 100, "bonus_points": 10,
        }
        self.attempt = {
            "round_no": 1, "problem_id": 7, "status": "active",
            "started_at": NOW - timedelta(milliseconds=USED_MS),
            "resolved_at": None, "paused_ms": 0, "pause_started_at": None, "suspended_at": None,
            "distraction_state": "missed", "distraction_at": 60,
            "distraction_index": 3, "submit_lock_until": None,
            "points": 0, "bonus": 0, "time_ms": None,
        }
        self.part = {
            "user_id": USER_ID, "status": "playing", "current_round": 1,
            "round_pts": 0, "bonus_pts": 0, "total_pts": 0,
            "solved_count": 0, "total_time_ms": 0,
            "distractions_cleared": 0, "distractions_total": 1,
            "active_client": None, "last_seen_at": None,
        }

    @asynccontextmanager
    async def transaction(self):
        # Represents the database participation row lock, including multiple workers.
        async with self.lock:
            yield self

    @asynccontextmanager
    async def acquire(self):
        yield self

    async def fetchrow(self, query, *args):
        compact = " ".join(query.split())
        self.statements.append((compact, args))
        if compact.startswith("SELECT status FROM public.event_config"):
            return {"status": self.ev["status"]}
        if compact.startswith("SELECT * FROM public.event_config"):
            return self.ev.copy()
        if compact.startswith("SELECT") and "public.participations" in compact:
            return {**self.part, "db_now": self.now}
        if compact.startswith("SELECT") and "public.round_attempts" in compact:
            return self.attempt.copy()
        if compact.startswith("UPDATE public.round_attempts"):
            if "SET status =" in compact:
                if self.attempt["status"] != "active":
                    return None
                for field in ("pause_started_at", "suspended_at"):
                    if self.attempt.get(field):
                        self.attempt["paused_ms"] += max(0, int((self.now - self.attempt[field]).total_seconds() * 1000))
                if self.attempt["distraction_state"] in ("pending", "active"):
                    self.attempt["distraction_state"] = "missed"
                self.attempt.update(
                    status=args[2], resolved_at=self.now, time_ms=args[3], points=args[4],
                    pause_started_at=None, suspended_at=None, submit_lock_until=None,
                )
            elif "distraction_state = 'missed'" in compact:
                self.attempt["paused_ms"] += args[2]
                self.attempt.update(pause_started_at=None, distraction_state="missed")
            else:
                raise AssertionError(f"Unexpected round update: {compact}")
            return self.attempt.copy()
        raise AssertionError(f"Unexpected fetchrow: {compact}")

    async def fetch(self, query, *args):
        if "SELECT * FROM public.round_attempts" in query and "status = 'active'" in query:
            return [self.attempt.copy()] if self.attempt and self.attempt["status"] == "active" else []
        if "SELECT round_no, status::text AS status" in query:
            if self.attempt["status"] == "active":
                return []
            return [{"round_no": 1, "status": self.attempt["status"]}]
        raise AssertionError(f"Unexpected fetch: {query}")

    async def execute(self, query, *args):
        compact = " ".join(query.split())
        self.statements.append((compact, args))
        if "SET round_pts = round_pts +" in compact:
            self.part["round_pts"] += args[1]
            self.part["solved_count"] += args[2]
            self.part["total_time_ms"] += args[3]
            self.part["total_pts"] = self.part["round_pts"] + self.part["bonus_pts"]
            if args[4]:
                self.part["status"] = "finished"
        elif compact.startswith("INSERT INTO public.distraction_events"):
            self.distraction_events.append(args)
        elif compact.startswith("UPDATE public.event_config SET status='ended'"):
            self.ev["status"] = "ended"
        else:
            raise AssertionError(f"Unexpected execute: {compact}")


@pytest.fixture
def round_db(monkeypatch):
    database = RoundDatabase()
    monkeypatch.setattr(arena.db, "transaction", database.transaction)
    monkeypatch.setattr(arena.db, "acquire", database.acquire)

    async def get_event(conn=None, **kwargs):
        return database.ev.copy()

    @asynccontextmanager
    async def guard(*args, **kwargs):
        # Separate server workers can judge simultaneously; row locking must remain sufficient.
        yield

    async def log_submission(*args, **kwargs):
        pass

    monkeypatch.setattr(event, "get_event", get_event)
    monkeypatch.setattr(arena.gate, "guard", guard)
    monkeypatch.setattr(arena, "_log_submission", log_submission)
    return database


def run(coroutine):
    return asyncio.run(coroutine)


def accepted():
    return Evaluation(cases=[CaseOutcome(index=0, status="pass")], time_ms=3, memory_kb=128)


def test_round_stays_open_well_after_legacy_deadline(round_db):
    ev, attempt, used_ms = run(arena._open_round(USER_ID))
    assert ev["status"] == "live" and attempt["status"] == "active"
    assert used_ms == USED_MS
    assert round_db.part["total_time_ms"] == 0
    assert not any(query.startswith("UPDATE") for query, _ in round_db.statements)


def test_state_reports_active_elapsed_time_excluding_distraction_pause(round_db):
    round_db.attempt.update(
        paused_ms=120_000,
        pause_started_at=NOW - timedelta(seconds=10),
        distraction_state="active",
    )
    state = run(arena.get_state(USER_ID)).model_dump(by_alias=True)
    assert state["round"]["elapsedSeconds"] == (USED_MS - 130_000) // 1000
    assert "secondsLeft" not in state["round"]
    assert state["round"]["distraction"]["remainingSeconds"] == 20
    assert state["round"]["status"] == "active" and not state["finished"]


def test_active_distraction_still_blocks_code_execution(round_db):
    round_db.attempt.update(
        pause_started_at=NOW - timedelta(seconds=10), distraction_state="active",
    )
    with pytest.raises(ApiError) as exc:
        run(arena._open_round(USER_ID))
    assert exc.value.status == 409 and exc.value.code == "distraction_active"
    assert round_db.attempt["status"] == "active"


def test_abandoned_distraction_times_out_once_without_expiring_question(round_db):
    round_db.attempt.update(
        pause_started_at=NOW - timedelta(seconds=40), distraction_state="active",
    )

    async def check():
        _, attempt, used_ms = await arena._open_round(USER_ID)
        assert attempt["status"] == "active" and attempt["distraction_state"] == "missed"
        assert attempt["paused_ms"] == 35_000 and attempt["pause_started_at"] is None
        assert used_ms == USED_MS - 35_000
        assert len(round_db.distraction_events) == 1
        await arena.get_state(USER_ID)
        assert len(round_db.distraction_events) == 1

    run(check())


def test_simultaneous_late_accepted_submissions_score_once_with_full_elapsed_time(round_db, monkeypatch):
    async def check():
        both_judging = asyncio.Event()
        arrivals = 0

        async def judge(attempt, req, **kwargs):
            nonlocal arrivals
            arrivals += 1
            if arrivals == 2:
                both_judging.set()
            await both_judging.wait()
            return SimpleNamespace(id=7), [], accepted()

        monkeypatch.setattr(arena, "_judge", judge)
        req = CodeRequest(language="python", code="print(42)")
        responses = await asyncio.gather(arena.submit(USER_ID, req), arena.submit(USER_ID, req))
        assert sum(response.result == "accepted" for response in responses) == 1
        assert round_db.attempt["status"] == "solved"
        assert round_db.attempt["time_ms"] == USED_MS
        assert round_db.part["total_time_ms"] == USED_MS
        assert round_db.part["round_pts"] == 100 and round_db.part["solved_count"] == 1
        with pytest.raises(ApiError) as exc:
            await arena._open_round(USER_ID)
        assert exc.value.code == "round_closed"

    run(check())


@pytest.mark.parametrize("first_evaluation,verdict", [
    (Evaluation(cases=[CaseOutcome(index=0, status="fail", actual="41")]), "wrong"),
    (Evaluation(compile=CompileInfo(message="SyntaxError", line=1, file="solution.py")), "compile-error"),
])
def test_failed_late_submission_can_be_corrected_without_losing_round(round_db, monkeypatch, first_evaluation, verdict):
    async def check():
        evaluations = iter([first_evaluation, accepted()])

        async def judge(attempt, req, **kwargs):
            return SimpleNamespace(id=7), [], next(evaluations)

        monkeypatch.setattr(arena, "_judge", judge)
        req = CodeRequest(language="python", code="print(42)")
        first = await arena.submit(USER_ID, req)
        assert first.result == verdict
        assert round_db.attempt["status"] == "active" and round_db.part["round_pts"] == 0
        round_db.now += timedelta(seconds=20)
        corrected = await arena.submit(USER_ID, req)
        assert corrected.result == "accepted"
        assert round_db.part["total_time_ms"] == USED_MS + 20_000

    run(check())


def test_ended_event_still_rejects_new_runs_and_submissions(round_db):
    round_db.ev["status"] = "ended"
    with pytest.raises(ApiError) as exc:
        run(arena._open_round(USER_ID))
    assert exc.value.status == 409 and exc.value.code == "event_not_live"
    assert round_db.part["round_pts"] == 0


def test_admin_event_cutoff_during_judging_prevents_late_points(round_db, monkeypatch):
    async def finalize(conn):
        # Closing at the admin cutoff resolves the active round before the judge returns.
        await arena._resolve_round(
            conn, round_db.ev, USER_ID, 1, status="expired",
            time_ms=arena.elapsed_ms(round_db.attempt, round_db.now), points=0,
        )
        round_db.part["status"] = "finished"

    async def judge(attempt, req, **kwargs):
        await event.end_event()
        return SimpleNamespace(id=7), [], accepted()

    monkeypatch.setattr(event, "finalize_all", finalize)
    monkeypatch.setattr(arena, "_judge", judge)
    response = run(arena.submit(USER_ID, CodeRequest(language="python", code="print(42)")))
    assert response.result == "expired"
    assert round_db.ev["status"] == "ended" and round_db.attempt["status"] == "expired"
    assert round_db.part["round_pts"] == 0 and round_db.part["solved_count"] == 0
    assert round_db.part["total_time_ms"] == USED_MS


def test_public_event_does_not_advertise_a_coding_deadline(round_db, monkeypatch):
    round_db.ev.update(
        started_at=NOW, ended_at=None, scheduled_at=NOW, timezone="UTC", timezone_label="UTC",
        name="Ctrl Alt Distract", organizer_name="Committee", college_name="VIT",
    )

    async def languages(conn=None):
        return [{"id": "python", "label": "Python", "filename": "solution.py"}]

    monkeypatch.setattr(event, "get_languages", languages)
    info = run(event.event_info()).model_dump(by_alias=True)
    assert info["roundSeconds"] is None and info["roundMinutes"] is None
    assert info["totalRounds"] == 10 and info["distractionSeconds"] == 30
