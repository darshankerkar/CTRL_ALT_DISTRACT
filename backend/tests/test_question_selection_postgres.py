"""Opt-in SQL integration checks using session-local PostgreSQL temporary tables.

Run with RUN_SELECTION_DB_TESTS=1. Shared competition rows are never modified:
service SQL is redirected to pg_temp, and temporary log tables have no shared sequences.
The compiler is stubbed because these tests verify question selection and scoring.
"""

import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app import security
from app.config import get_settings
from app.db import _init_connection
from app.errors import ApiError
from app.main import create_app
from app.schemas import CodeRequest, DistractionResolveRequest, ProblemPublic
from app.services import arena, catalog, event, people
from tests.test_unlimited_rounds import USER_ID, accepted

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_SELECTION_DB_TESTS") != "1",
    reason="Opt-in: needs configured PostgreSQL, uses only temporary tables",
)


class TemporaryConnection:
    """Fail closed if a service tries to access a table outside this fixture."""

    tables = {"event_config", "participations", "round_attempts", "profiles", "submissions", "distraction_events"}

    def __init__(self, conn):
        self.conn = conn

    def sql(self, query):
        def replace(match):
            name = match.group(1)
            assert name in self.tables, f"Unexpected shared table access: {name}"
            return f"pg_temp.{name}"
        query = re.sub(r"public\.([a-z_]+)", replace, query)
        assert "public." not in query
        return query

    async def fetch(self, query, *args):
        return await self.conn.fetch(self.sql(query), *args)

    async def fetchrow(self, query, *args):
        return await self.conn.fetchrow(self.sql(query), *args)

    async def fetchval(self, query, *args):
        return await self.conn.fetchval(self.sql(query), *args)

    async def execute(self, query, *args):
        return await self.conn.execute(self.sql(query), *args)


@pytest_asyncio.fixture
async def isolated_db(monkeypatch):
    settings = get_settings()
    conn = await asyncpg.connect(
        settings.database_url, ssl="require" if "supabase" in settings.database_url else None,
        statement_cache_size=0, command_timeout=30,
    )
    await _init_connection(conn)
    proxy = TemporaryConnection(conn)
    try:
        for name in ("event_config", "participations", "round_attempts"):
            await conn.execute(f"CREATE TEMP TABLE {name} (LIKE public.{name} INCLUDING DEFAULTS INCLUDING GENERATED)")
        await conn.execute("ALTER TABLE pg_temp.participations ADD PRIMARY KEY (user_id)")
        await conn.execute("ALTER TABLE pg_temp.round_attempts ADD PRIMARY KEY (user_id, round_no)")
        migration = Path(__file__).resolve().parents[2] / "supabase/migrations/009_question_selection.sql"
        await proxy.execute(migration.read_text(encoding="utf-8"))
        # Only a read of shared configuration; all subsequent changes target pg_temp.
        await conn.execute("INSERT INTO pg_temp.event_config SELECT * FROM public.event_config")
        await conn.execute("UPDATE pg_temp.event_config SET status='live', total_rounds=10, dsa_points=100, "
                           "distraction_min_at=1000000, distraction_max_at=1000000")
        await conn.execute("CREATE TEMP TABLE profiles (id UUID PRIMARY KEY, full_name TEXT, player_no INTEGER)")
        await conn.execute("INSERT INTO pg_temp.profiles VALUES ($1::uuid, 'Selection Test', 1)", USER_ID)
        await conn.execute("CREATE TEMP TABLE submissions (user_id UUID, problem_id INT, round_no INT, language TEXT, "
                           "kind TEXT, code TEXT, verdict TEXT, passed INT, total INT, runtime_ms INT, memory_kb INT, detail TEXT)")
        await conn.execute("CREATE TEMP TABLE distraction_events (user_id UUID, round_no INT, distraction_index INT, "
                           "distraction_id TEXT, result TEXT, time_taken INT, bonus INT DEFAULT 0, metrics JSONB)")
        await conn.execute("INSERT INTO pg_temp.participations (user_id, problem_order, distraction_order) "
                           "VALUES ($1::uuid, $2, $2)", USER_ID, list(range(1, 11)))

        @asynccontextmanager
        async def acquire():
            yield proxy

        @asynccontextmanager
        async def transaction():
            async with conn.transaction():
                yield proxy

        @asynccontextmanager
        async def guard(*args, **kwargs):
            yield

        async def problem(problem_id):
            public = ProblemPublic(
                round=problem_id, title=f"Question {problem_id}",
                difficulty=("EASY", "MEDIUM", "HARD")[(problem_id - 1) % 3],
                points=100, tags=[], description=[f"Public statement {problem_id}"],
                input_format="An integer", output_format="An integer", examples=[],
                constraints=[], hints=[], samples=[], starter_code={"python": "pass"},
            )
            return SimpleNamespace(id=problem_id, public=public)

        async def judge(attempt, req, **kwargs):
            return await problem(attempt["problem_id"]), [], accepted()

        monkeypatch.setattr(arena.db, "acquire", acquire)
        monkeypatch.setattr(arena.db, "transaction", transaction)
        monkeypatch.setattr(arena.gate, "guard", guard)
        monkeypatch.setattr(catalog, "get_problem", problem)
        monkeypatch.setattr(arena, "_judge", judge)
        monkeypatch.setattr(event, "_event_cache", None)
        monkeypatch.setattr(people, "_leaderboard_cache", None)
        yield proxy
    finally:
        await conn.close()  # PostgreSQL drops all session-local tables automatically.


@pytest.mark.asyncio
async def test_list_contains_only_ten_assigned_public_questions_and_validates_selection(isolated_db):
    listed = (await arena.questions(USER_ID)).model_dump(by_alias=True)
    assert len(listed["items"]) == 10
    assert {item["round"] for item in listed["items"]} == set(range(1, 11))
    assert all(item["status"] == "unsolved" for item in listed["items"])
    assert all(set(item) == {"round", "title", "difficulty", "points", "status", "description", "inProgress"}
               for item in listed["items"])
    assert (await arena.current_problem(USER_ID, 10)).title == "Question 10"
    for number in (0, 11):
        with pytest.raises(ApiError) as exc:
            await arena.select_question(USER_ID, number)
        assert exc.value.code == "locked_round"
    state = await arena.select_question(USER_ID, 10)
    assert state.round.round == 10 and not state.finished
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts") == 1


@pytest.mark.asyncio
async def test_switch_resume_accumulates_active_time_and_keeps_distraction_schedule(isolated_db):
    await arena.select_question(USER_ID, 10)
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '20 seconds', "
                              "distraction_at=1234, distraction_index=7 WHERE round_no=10")
    await arena.select_question(USER_ID, 2)
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '80 seconds', "
                              "suspended_at=now()-interval '60 seconds' WHERE round_no=10")
    resumed = await arena.select_question(USER_ID, 10)
    assert 19 <= resumed.round.elapsed_seconds <= 21
    saved = await isolated_db.fetchrow("SELECT * FROM public.round_attempts WHERE round_no=10")
    assert saved["suspended_at"] is None and 59900 <= saved["paused_ms"] <= 61000
    assert saved["distraction_at"] == 1234 and saved["distraction_index"] == 7
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts WHERE status='active' AND suspended_at IS NULL") == 1
    again = await arena.start_or_advance(USER_ID)
    assert again.round.round == 10
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts") == 2


@pytest.mark.asyncio
async def test_solve_question_ten_first_then_remaining_questions_and_score_once(isolated_db):
    for index, number in enumerate([10, 3, 8, 1, 9, 2, 7, 4, 6, 5], start=1):
        await arena.select_question(USER_ID, number)
        result = await arena.submit(USER_ID, CodeRequest(language="python", code="print(42)", round=number))
        assert result.round == number and result.result == "accepted"
        assert result.participant.solved_count == index and result.participant.round_pts == index * 100
        assert (result.participant.status == "finished") == (index == 10)
        if index < 10:
            with pytest.raises(ApiError) as exc:
                await arena.select_question(USER_ID, number)
            assert exc.value.code == "already_solved"
    state = await arena.get_state(USER_ID)
    assert state.finished and len(state.rounds) == 10
    assert (await arena.questions(USER_ID)).finished
    assert all(item.status == "solved" for item in (await arena.questions(USER_ID)).items)
    assert await isolated_db.fetchval("SELECT count(*) FROM public.submissions") == 10
    with pytest.raises(ApiError) as exc:
        await arena.select_question(USER_ID, 1)
    assert exc.value.code == "participant_finished"


@pytest.mark.asyncio
async def test_stale_code_and_game_requests_cannot_target_newly_selected_question(isolated_db):
    await arena.select_question(USER_ID, 1)
    await arena.select_question(USER_ID, 2)
    operations = [arena.run(USER_ID, CodeRequest(language="python", code="print(42)", round=1)),
                  arena.submit(USER_ID, CodeRequest(language="python", code="print(42)", round=1)),
                  arena.distraction_start(USER_ID, 1),
                  arena.distraction_resolve(USER_ID, DistractionResolveRequest(round=1, result="passed", time_taken=2))]
    for operation in operations:
        with pytest.raises(ApiError) as exc:
            await operation
        assert exc.value.code == "question_changed"
    assert await isolated_db.fetchval("SELECT count(*) FROM public.submissions") == 0
    assert await isolated_db.fetchval("SELECT round_pts FROM public.participations") == 0


@pytest.mark.asyncio
async def test_due_and_active_distractions_block_switching_without_changing_current_question(isolated_db):
    await arena.select_question(USER_ID, 1)
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '100 seconds', distraction_at=60")
    with pytest.raises(ApiError) as exc:
        await arena.select_question(USER_ID, 2)
    assert exc.value.code == "distraction_due"
    state = await arena.distraction_start(USER_ID, 1)
    assert state.round.distraction.state == "active"
    with pytest.raises(ApiError) as exc:
        await arena.select_question(USER_ID, 2)
    assert exc.value.code == "distraction_active"
    assert await isolated_db.fetchval("SELECT current_round FROM public.participations") == 1
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts") == 1


@pytest.mark.parametrize("completion", ["exit", "admin"])
@pytest.mark.asyncio
async def test_completion_closes_every_suspended_attempt_preserving_score_and_time(isolated_db, completion):
    await arena.select_question(USER_ID, 10)
    await arena.submit(USER_ID, CodeRequest(language="python", code="print(42)", round=10))
    await arena.select_question(USER_ID, 1)
    await arena.select_question(USER_ID, 2)
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '80 seconds', "
                              "suspended_at=now()-interval '60 seconds' WHERE round_no=1")
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '30 seconds' WHERE round_no=2")
    await isolated_db.execute("UPDATE public.participations SET bonus_pts=10, distractions_cleared=1, distractions_total=1")
    before = await isolated_db.fetchval("SELECT total_time_ms FROM public.participations")
    if completion == "exit":
        state = await arena.exit_challenge(USER_ID)
        assert state.finished
    else:
        await event.end_event()
    total = await isolated_db.fetchval("SELECT total_time_ms FROM public.participations")
    assert 49000 <= total - before <= 52000
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts WHERE status='active'") == 0
    assert await isolated_db.fetchval("SELECT count(*) FROM public.round_attempts WHERE suspended_at IS NOT NULL") == 0
    assert (await arena.results(USER_ID)).total == 110
    people.invalidate_leaderboard()
    board = await people.leaderboard(USER_ID, None)
    assert board.total == 1 and board.entries[0].total == 110
    await arena.exit_challenge(USER_ID)
    assert await isolated_db.fetchval("SELECT total_time_ms FROM public.participations") == total
    assert await isolated_db.fetchval("SELECT count(*) FROM public.submissions") == 1


@pytest.mark.asyncio
async def test_judging_old_question_after_switch_scores_only_that_question(isolated_db, monkeypatch):
    await arena.select_question(USER_ID, 1)
    await isolated_db.execute("UPDATE public.round_attempts SET started_at=now()-interval '12 seconds'")

    async def delayed_judge(attempt, req, **kwargs):
        await arena.select_question(USER_ID, 10)
        return await catalog.get_problem(attempt["problem_id"]), [], accepted()

    monkeypatch.setattr(arena, "_judge", delayed_judge)
    response = await arena.submit(USER_ID, CodeRequest(language="python", code="print(42)", round=1))
    assert response.round == 1 and response.result == "accepted"
    assert response.participant.current_round == 10 and response.participant.solved_count == 1
    assert not (await arena.get_state(USER_ID)).finished
    assert await isolated_db.fetchval("SELECT status FROM public.round_attempts WHERE round_no=1") == "solved"
    assert await isolated_db.fetchval("SELECT status FROM public.round_attempts WHERE round_no=10") == "active"
    assert 11900 <= response.participant.total_time_ms <= 13000


@pytest.mark.asyncio
async def test_question_endpoints_auth_validation_and_response_contract(isolated_db):
    app = create_app()
    app.dependency_overrides[security.optional_user] = lambda: None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/api/arena/questions")).status_code == 401
        assert (await client.post("/api/arena/select", json={"round": 10})).status_code == 401
        app.dependency_overrides[security.current_user] = lambda: security.AuthUser(USER_ID, "test@example.com", "participant")
        listed = await client.get("/api/arena/questions")
        assert listed.status_code == 200 and len(listed.json()["items"]) == 10
        assert (await client.post("/api/arena/select", json={"round": 0})).status_code == 422
        assert (await client.post("/api/arena/select", json={"round": 11})).status_code == 403
        selected = await client.post("/api/arena/select", json={"round": 10})
        assert selected.status_code == 200 and selected.json()["round"]["round"] == 10
        assert not selected.json()["finished"]
