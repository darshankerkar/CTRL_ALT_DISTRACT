"""Voluntary challenge completion preserves scores, history and leaderboard access.

Database calls and judging are local fakes. No test connects to the shared event.
"""

import asyncio
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from app import security
from app.errors import ApiError
from app.main import create_app
from app.schemas import CodeRequest, DistractionResolveRequest
from app.services import arena, event, people
from tests.test_unlimited_rounds import NOW, USED_MS, USER_ID, RoundDatabase, accepted, run


class ExitDatabase(RoundDatabase):
    """A participant on question 3, with two scored rounds and submission history."""

    def __init__(self):
        super().__init__()
        self.part.update(
            current_round=3, round_pts=200, bonus_pts=20, total_pts=220,
            solved_count=2, total_time_ms=90_000, distractions_cleared=2,
            distractions_total=3, finished_at=None,
        )
        self.attempt["round_no"] = 3
        self.previous_rounds = [{"round_no": 1, "status": "solved"}, {"round_no": 2, "status": "solved"}]
        self.submissions = [{"round_no": 1, "verdict": "accepted"}, {"round_no": 2, "verdict": "accepted"}]

    async def fetchrow(self, query, *args):
        if query == "SELECT * FROM public.event_config FOR SHARE":
            self.statements.append((query, args))
            return self.ev.copy()
        if "public.profiles" in query:
            return {"full_name": "Exit Test Player", "player_no": 1}
        if "public.participations" in query and query.lstrip().startswith("SELECT") and self.part is None:
            return None
        if "public.round_attempts" in query and query.lstrip().startswith("SELECT") and self.attempt is None:
            return None
        return await super().fetchrow(query, *args)

    async def fetch(self, query, *args):
        if "SELECT round_no, status::text AS status" in query:
            current = [] if self.attempt is None or self.attempt["status"] == "active" else [
                {"round_no": self.attempt["round_no"], "status": self.attempt["status"]}
            ]
            return self.previous_rounds + current
        if "SELECT round_no FROM public.round_attempts" in query:
            current = [] if self.attempt is None or self.attempt["status"] != "solved" else [
                {"round_no": self.attempt["round_no"]}
            ]
            return self.previous_rounds + current
        if "row_number() OVER" in query and "public.participations" in query:
            # Retain the real leaderboard inclusion condition: finished entries remain ranked.
            assert "WHERE pa.status <> 'joined'" in query
            if self.part["status"] == "joined":
                return []
            return [{
                "rank": 1, "user_id": USER_ID, "full_name": "Exit Test Player", "player_no": 1,
                **{key: self.part[key] for key in ("round_pts", "bonus_pts", "total_pts", "total_time_ms")},
            }]
        return await super().fetch(query, *args)

    async def execute(self, query, *args):
        compact = " ".join(query.split())
        if compact.startswith("UPDATE public.round_attempts SET paused_ms = paused_ms + $3"):
            self.statements.append((compact, args))
            self.attempt["paused_ms"] += args[2]
            self.attempt["pause_started_at"] = None
            self.attempt["suspended_at"] = None
            if self.attempt["distraction_state"] in ("pending", "active"):
                self.attempt["distraction_state"] = "missed"
            return "UPDATE 1"
        if compact.startswith("UPDATE public.participations") and "SET status = 'finished'" in compact:
            self.statements.append((compact, args))
            assert "COALESCE(finished_at" in compact
            self.part["status"] = "finished"
            self.part["finished_at"] = self.part["finished_at"] or self.now
            return "UPDATE 1"
        return await super().execute(query, *args)


@pytest.fixture
def exit_db(monkeypatch):
    database = ExitDatabase()
    monkeypatch.setattr(arena.db, "transaction", database.transaction)
    monkeypatch.setattr(arena.db, "acquire", database.acquire)
    monkeypatch.setattr(people, "_leaderboard_cache", None)

    async def get_event(conn=None, **kwargs):
        return database.ev.copy()

    async def log_submission(user_id, problem_id, round_no, req, kind, verdict, evaluation):
        database.submissions.append({"round_no": round_no, "verdict": verdict})

    @asynccontextmanager
    async def guard(*args, **kwargs):
        yield

    monkeypatch.setattr(event, "get_event", get_event)
    monkeypatch.setattr(arena, "_log_submission", log_submission)
    monkeypatch.setattr(arena.gate, "guard", guard)
    return database


def test_exit_preserves_scores_history_and_leaderboard(exit_db):
    async def check():
        history = exit_db.submissions.copy()
        people._leaderboard_cache = (time.monotonic() + 30, [])
        state = await arena.exit_challenge(USER_ID)
        assert state.finished and state.participant.status == "finished"
        assert state.participant.current_round == 3
        assert state.participant.round_pts == 200 and state.participant.bonus_pts == 20
        assert state.participant.total_pts == 220 and state.participant.solved_count == 2
        assert state.participant.total_time_ms == 90_000 + USED_MS
        assert exit_db.attempt["status"] == "expired" and exit_db.attempt["points"] == 0
        assert exit_db.submissions == history
        assert exit_db.previous_rounds == [{"round_no": 1, "status": "solved"}, {"round_no": 2, "status": "solved"}]
        leaderboard = await people.leaderboard(USER_ID, None)
        assert leaderboard.total == 1 and leaderboard.entries[0].self
        assert leaderboard.entries[0].round_pts == 200 and leaderboard.entries[0].bonus == 20
        assert leaderboard.entries[0].total == 220
        result = await arena.results(USER_ID)
        assert result.total == 220 and result.solved == 2
        assert result.rounds == [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]
        assert not any(query.startswith("DELETE") for query, _ in exit_db.statements)

    run(check())


def test_second_exit_and_refresh_do_not_add_time_or_change_completion(exit_db):
    async def check():
        await arena.exit_challenge(USER_ID)
        totals = exit_db.part.copy()
        resolved_at = exit_db.attempt["resolved_at"]
        exit_db.now += timedelta(hours=1)
        second = await arena.exit_challenge(USER_ID)
        refreshed = await arena.get_state(USER_ID)
        assert second.finished and refreshed.finished
        assert second.participant == refreshed.participant
        assert exit_db.part == totals and exit_db.attempt["resolved_at"] == resolved_at

    run(check())


def test_parallel_exit_requests_resolve_round_once(exit_db):
    async def check():
        first, second = await asyncio.gather(arena.exit_challenge(USER_ID), arena.exit_challenge(USER_ID))
        assert first.finished and second.finished and first.participant == second.participant
        assert exit_db.part["total_time_ms"] == 90_000 + USED_MS
        assert exit_db.part["total_pts"] == 220 and exit_db.part["solved_count"] == 2
        assert len([query for query, _ in exit_db.statements if "SET round_pts = round_pts +" in query]) == 1

    run(check())


@pytest.mark.parametrize("distraction_state", ["pending", "cleared"])
def test_exit_preserves_existing_bonus_and_closes_pending_distraction(exit_db, distraction_state):
    exit_db.attempt.update(distraction_state=distraction_state, bonus=10 if distraction_state == "cleared" else 0)
    state = run(arena.exit_challenge(USER_ID))
    assert state.participant.bonus_pts == 20 and state.participant.total_pts == 220
    assert exit_db.attempt["distraction_state"] == ("cleared" if distraction_state == "cleared" else "missed")
    assert exit_db.attempt["bonus"] == (10 if distraction_state == "cleared" else 0)
    assert not exit_db.distraction_events


def test_exit_between_rounds_keeps_just_earned_points_and_time(exit_db):
    async def check():
        await arena._resolve_round(exit_db, exit_db.ev, USER_ID, 3, status="solved", time_ms=USED_MS, points=100)
        totals = {key: exit_db.part[key] for key in ("round_pts", "bonus_pts", "total_pts", "solved_count", "total_time_ms")}
        exit_db.now += timedelta(seconds=40)
        state = await arena.exit_challenge(USER_ID)
        assert state.finished and state.round.status == "solved"
        assert state.participant.solved_count == 3 and state.participant.total_pts == 320
        assert all(exit_db.part[key] == value for key, value in totals.items())

    run(check())


def test_exit_during_distraction_records_pause_without_awarding_bonus(exit_db):
    exit_db.attempt.update(
        paused_ms=5_000, pause_started_at=NOW - timedelta(seconds=12), distraction_state="active",
    )

    async def check():
        state = await arena.exit_challenge(USER_ID)
        assert state.finished and state.participant.total_time_ms == 90_000 + USED_MS - 17_000
        assert exit_db.attempt["paused_ms"] == 17_000
        assert exit_db.attempt["pause_started_at"] is None and exit_db.attempt["distraction_state"] == "missed"
        assert state.participant.bonus_pts == 20 and state.participant.distractions_cleared == 2
        assert len(exit_db.distraction_events) == 1
        assert exit_db.distraction_events[0][-1] == {"reason": "participant_exit"}
        # A delayed distraction response must not grant a bonus after voluntary completion.
        result = await arena.distraction_resolve(USER_ID, DistractionResolveRequest(result="passed", time_taken=12))
        assert not result.cleared and result.bonus == 0 and exit_db.part["bonus_pts"] == 20
        await arena.exit_challenge(USER_ID)
        assert len(exit_db.distraction_events) == 1

    run(check())


@pytest.mark.parametrize("operation", ["start", "run", "submit"])
def test_finished_participant_cannot_resume_or_submit(exit_db, operation):
    async def check():
        await arena.exit_challenge(USER_ID)
        if operation == "start":
            state = await arena.start_or_advance(USER_ID)
            assert state.finished and state.participant.current_round == 3
        else:
            with pytest.raises(ApiError) as exc:
                await getattr(arena, operation)(USER_ID, CodeRequest(language="python", code="print(42)"))
            assert exc.value.status == 409
        assert exit_db.part["round_pts"] == 200 and exit_db.part["current_round"] == 3

    run(check())


def test_in_flight_accepted_judge_cannot_award_points_after_exit(exit_db, monkeypatch):
    async def judge(attempt, req, **kwargs):
        await arena.exit_challenge(USER_ID)
        return SimpleNamespace(id=7), [], accepted()

    monkeypatch.setattr(arena, "_judge", judge)
    result = run(arena.submit(USER_ID, CodeRequest(language="python", code="print(42)")))
    assert result.result == "expired" and result.participant.status == "finished"
    assert exit_db.part["round_pts"] == 200 and exit_db.part["solved_count"] == 2
    assert exit_db.part["total_time_ms"] == 90_000 + USED_MS
    assert len(exit_db.submissions) == 3  # The attempt remains available in audit history.


def test_accepted_submit_before_exit_keeps_earned_score(exit_db, monkeypatch):
    async def judge(attempt, req, **kwargs):
        return SimpleNamespace(id=7), [], accepted()

    monkeypatch.setattr(arena, "_judge", judge)

    async def check():
        result = await arena.submit(USER_ID, CodeRequest(language="python", code="print(42)"))
        assert result.result == "accepted"
        state = await arena.exit_challenge(USER_ID)
        assert state.finished and state.participant.total_pts == 320
        assert state.participant.solved_count == 3 and state.participant.total_time_ms == 90_000 + USED_MS

    run(check())


def test_exit_endpoint_requires_authentication():
    app = create_app()
    app.dependency_overrides[security.optional_user] = lambda: None

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/arena/exit")
            assert response.status_code == 401 and response.json()["error"] == "unauthorized"

    run(check())


def test_exit_endpoint_keeps_scores_in_response(exit_db):
    app = create_app()
    app.dependency_overrides[security.current_user] = lambda: security.AuthUser(USER_ID, "player@example.com", "participant")

    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/arena/exit")
            assert response.status_code == 200
            body = response.json()
            assert body["finished"] and body["participant"]["status"] == "finished"
            assert body["participant"]["totalPts"] == 220 and body["participant"]["solvedCount"] == 2

    run(check())


def test_not_joined_participant_cannot_exit(exit_db):
    exit_db.part = None
    with pytest.raises(ApiError) as exc:
        run(arena.exit_challenge(USER_ID))
    assert exc.value.status == 409 and exc.value.code == "not_joined"


def test_lobby_participant_cannot_complete_unstarted_challenge(exit_db):
    exit_db.part.update(status="joined", current_round=0)
    exit_db.attempt = None
    with pytest.raises(ApiError) as exc:
        run(arena.exit_challenge(USER_ID))
    assert exc.value.status == 409 and exc.value.code == "not_started"
    assert exit_db.part["status"] == "joined" and exit_db.part["finished_at"] is None
