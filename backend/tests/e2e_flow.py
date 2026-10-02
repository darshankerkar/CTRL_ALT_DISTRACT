"""End-to-end API walkthrough: real Postgres + real Judge0, in-process ASGI (no HTTP server needed).

Creates throwaway users (e2e-*@test.invalid), plays two full runs, checks every guard, then deletes
everything it created and puts the event back in the lobby. It refuses to run if any real
participant exists or the event is not in the lobby.

    python -m tests.e2e_flow ["<questions PDF>"]

It exercises the function-style demo problems, so it temporarily swaps the event's problem set for
them. Pass the questions PDF to have the real set restored afterwards; otherwise run
`python -m app.cli seed --pdf <file> --trust-oracle` yourself.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

os.environ.setdefault("RUN_INTERVAL_S", "0")
os.environ.setdefault("SUBMIT_INTERVAL_S", "0")

import httpx  # noqa: E402
from fastapi import Header  # noqa: E402

from app.db import db  # noqa: E402
from app.judge.judge0 import Judge0Client  # noqa: E402
from app.main import create_app  # noqa: E402
from app.security import AuthUser, current_user, optional_user  # noqa: E402
from app.services import arena as arena_service  # noqa: E402
from app.services import event as event_service  # noqa: E402

from .solutions import SOLUTIONS  # noqa: E402

DOMAIN = "test.invalid"
passed = failed = 0


def check(label: str, ok: bool, extra: object = "") -> None:
    global passed, failed
    passed += ok
    failed += not ok
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'' if ok else f'  -> {extra}'}")


async def make_user(conn, name: str, prefix: str = "e2e") -> str:
    uid = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, "
        "raw_user_meta_data, created_at, updated_at) VALUES ($1::uuid, '00000000-0000-0000-0000-000000000000', "
        "'authenticated', 'authenticated', $2, '', '{}'::jsonb, jsonb_build_object('full_name', $3::text), now(), now())",
        uid, f"{prefix}-{uid[:8]}@{DOMAIN}", name,
    )
    return uid


async def main(pdf: str | None = None) -> int:
    await db.connect()
    judge_client = Judge0Client()
    arena_service.set_judge_client(judge_client)
    app = create_app()

    async def fake_user(x_test_user: str = Header()) -> AuthUser:
        return AuthUser(id=x_test_user, email=None, token_role="participant")

    async def fake_optional(x_test_user: str | None = Header(default=None)) -> AuthUser | None:
        return AuthUser(id=x_test_user, email=None, token_role="participant") if x_test_user else None

    app.dependency_overrides[current_user] = fake_user
    app.dependency_overrides[optional_user] = fake_optional

    async with db.acquire() as conn:
        ev = await conn.fetchrow("SELECT status FROM public.event_config")
        real = await conn.fetchval("SELECT count(*) FROM public.participations")
        if ev["status"] != "lobby" or real:
            print(f"refusing to run: event={ev['status']} participations={real}")
            return 2
        from app.seed.loader import seed_problems

        await seed_problems(conn)  # function-style demo set (10 rounds)
        event_service.invalidate()
        ada = await make_user(conn, "Ada Lovelace")
        bob = await make_user(conn, "Bob Builder")
        root = await make_user(conn, "Root Admin")
        await conn.execute("UPDATE public.profiles SET role = 'admin' WHERE id = $1::uuid", root)

    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://api", timeout=120)
    H = lambda u, tab=None: {"x-test-user": u, **({"x-client-id": tab} if tab else {})}  # noqa: E731

    async def call(method, url, user=None, **kw):
        headers = H(user, kw.pop("tab", None)) if user else {}
        r = await client.request(method, url, headers=headers, **kw)
        return r

    try:
        print("\n[public + lobby]")
        r = await call("GET", "/api/event")
        info = r.json()
        check("GET /api/event is the lobby with seeded config", r.status_code == 200 and info["status"] == "lobby" and info["totalRounds"] == 10, r.text)
        check("event labels derive from scheduled_at", info["eventDate"] == "18 OCT 2026" and info["eventTime"] == "10:00 IST", info)
        check("languages come from the database", [l["id"] for l in info["languages"]] == ["python", "cpp", "c", "java"], info["languages"])

        r = await call("GET", "/api/me", ada)
        check("/api/me before joining has no participation", r.status_code == 200 and r.json()["participation"] is None and r.json()["playerCode"].startswith("CAD-"), r.text)
        check("join ada", (await call("POST", "/api/participant/join", ada)).status_code == 204)
        check("join bob", (await call("POST", "/api/participant/join", bob)).status_code == 204)
        async with db.acquire() as conn:  # this walkthrough assumes round N = demo problem N, so pin the (normally random) order
            await conn.execute(
                "UPDATE public.participations SET problem_order = ARRAY(SELECT id FROM public.problems ORDER BY round_no)"
            )
        check("join is idempotent", (await call("POST", "/api/participant/join", bob)).status_code == 204)
        lobby = (await call("GET", "/api/lobby", ada)).json()
        check("lobby counts both players with real names", lobby["count"] == 2 and {p["name"] for p in lobby["players"]} == {"Ada Lovelace", "Bob Builder"}, lobby)
        r = await call("POST", "/api/arena/start", ada)
        check("arena start is refused while in the lobby", r.status_code == 409 and r.json()["error"] == "event_not_live", r.text)
        r = await call("GET", "/api/admin/overview", ada)
        check("participants cannot reach admin routes", r.status_code == 403, r.text)

        print("\n[admin start]")
        r = await call("GET", "/api/admin/overview", root)
        check("admin overview shows 2 players", r.status_code == 200 and r.json()["players"] == 2, r.text)
        check("admin starts the event", (await call("POST", "/api/admin/event/start", root)).status_code == 204)
        check("starting twice is a conflict", (await call("POST", "/api/admin/event/start", root)).status_code == 409)
        check("event reports live", (await call("GET", "/api/event")).json()["status"] == "live")

        print("\n[ada plays]")
        r = await call("POST", "/api/arena/start", ada, tab="tab-A")
        st = r.json()
        check("round 1 begins with elapsed time and no deadline", r.status_code == 200 and st["round"]["round"] == 1 and 0 <= st["round"]["elapsedSeconds"] <= 5 and "secondsLeft" not in st["round"], r.text)
        check("distraction is scheduled 180-300s in", 180 <= st["round"]["distraction"]["atSeconds"] <= 300 and st["round"]["distraction"]["state"] == "pending", st["round"])
        again = (await call("POST", "/api/arena/start", ada, tab="tab-A")).json()
        check("start is idempotent while the round is active", again["round"]["round"] == 1)

        prob = (await call("GET", "/api/arena/problem", ada)).json()
        check("problem 1 payload", prob["title"] == "Max Subarray Sum" and set(prob["starterCode"]) == {"python", "cpp", "c", "java"} and prob["points"] == 100, prob.get("title"))
        check("assigned round 2 problem is available", (await call("GET", "/api/arena/problem?round=2", ada)).status_code == 200)

        wrong = {"language": "python", "code": "class Solution:\n    def maxSubArray(self, nums):\n        return 0\n"}
        r = await call("POST", "/api/arena/run", ada, json=wrong)
        run = r.json()
        check("run: wrong code -> failed with per-case actuals", r.status_code == 200 and run["result"] == "failed" and run["total"] == 3 and run["cases"][0]["actual"] == "0" and run["cases"][0]["expected"] == "6", run)
        check("run exposes only sample inputs", all(c["input"].startswith("nums = ") for c in run["cases"]), run["cases"])
        bad = {"language": "python", "code": "class Solution:\n    def maxSubArray(self, nums)\n        return 0\n"}
        run = (await call("POST", "/api/arena/run", ada, json=bad)).json()
        check("run: syntax error -> compile-error with line", run["result"] == "compile-error" and run["compile"]["line"] == 2 and run["compile"]["file"] == "solution.py", run["compile"])
        r = await call("POST", "/api/arena/submit", ada, json=wrong)
        sub = r.json()
        check("submit: wrong answer scores nothing", r.status_code == 200 and sub["result"] == "wrong" and sub["headline"] == "WRONG ANSWER" and sub["participant"]["totalPts"] == 0, sub)
        check("submit counts the hidden tests", sub["total"] == 19, sub["total"])
        check("unsupported language rejected", (await call("POST", "/api/arena/run", ada, json={"language": "ruby", "code": "x"})).status_code == 400)

        good = {"language": "python", "code": SOLUTIONS["max-subarray-sum"]["python"]}
        sub = (await call("POST", "/api/arena/submit", ada, json=good)).json()
        check("submit: correct -> accepted, +100", sub["result"] == "accepted" and sub["passed"] == 19 and sub["participant"]["roundPts"] == 100, sub)
        r = await call("POST", "/api/arena/submit", ada, json=good)
        check("a solved round cannot be submitted (or scored) twice", r.status_code == 409 and r.json()["error"] == "round_closed", r.text)
        st = (await call("GET", "/api/arena/state", ada, tab="tab-A")).json()
        check("state shows round 1 solved", st["rounds"] == [{"round": 1, "status": "solved"}] and st["round"]["status"] == "solved", st)

        print("\n[advance, distraction, elapsed time]")
        st = (await call("POST", "/api/arena/start", ada, tab="tab-A")).json()
        check("advance -> round 2 with fresh elapsed time", st["round"]["round"] == 2 and st["round"]["elapsedSeconds"] <= 5, st["round"])
        r = await call("POST", "/api/arena/distraction/start", ada)
        check("distraction cannot be started early", r.status_code == 409 and r.json()["error"] == "too_early", r.text)
        async with db.acquire() as conn:  # fast-forward the round clock by 200s
            await conn.execute("UPDATE public.round_attempts SET started_at = now() - interval '200 seconds', distraction_at = 190 WHERE user_id = $1::uuid AND round_no = 2", ada)
        st = (await call("GET", "/api/arena/state", ada, tab="tab-A")).json()
        check("clock reflects 200s elapsed", 199 <= st["round"]["elapsedSeconds"] <= 205, st["round"]["elapsedSeconds"])
        st = (await call("POST", "/api/arena/distraction/start", ada)).json()
        check("distraction goes active", st["round"]["distraction"]["state"] == "active" and st["participant"]["distractionsTotal"] == 1, st["round"])
        r = await call("POST", "/api/arena/run", ada, json=good)
        check("run/submit are blocked during a distraction", r.status_code == 409 and r.json()["error"] == "distraction_active", r.text)
        await asyncio.sleep(2.2)
        st2 = (await call("GET", "/api/arena/state", ada)).json()
        check("elapsed coding time is frozen while the distraction runs", abs(st2["round"]["elapsedSeconds"] - st["round"]["elapsedSeconds"]) <= 1, (st["round"]["elapsedSeconds"], st2["round"]["elapsedSeconds"]))
        r = await call("POST", "/api/arena/distraction/resolve", ada, json={"result": "passed", "timeTaken": 9, "distractionId": "quick-math", "metrics": {"correct": 4}})
        res = r.json()
        check("passing the distraction awards +50", r.status_code == 200 and res["cleared"] and res["bonus"] == 50 and res["participant"]["bonusPts"] == 50, res)
        res2 = (await call("POST", "/api/arena/distraction/resolve", ada, json={"result": "passed", "timeTaken": 9})).json()
        check("distraction bonus cannot be claimed twice", res2["participant"]["bonusPts"] == 50, res2)
        st = (await call("GET", "/api/arena/state", ada)).json()
        check("distraction state persisted as cleared; elapsed time resumed", st["round"]["distraction"]["state"] == "cleared" and st["round"]["elapsedSeconds"] >= 199, st["round"])

        async with db.acquire() as conn:  # spend more than the old 600-second question limit
            await conn.execute("UPDATE public.round_attempts SET started_at = now() - interval '700 seconds' WHERE user_id = $1::uuid AND round_no = 2", ada)
        st = (await call("GET", "/api/arena/state", ada)).json()
        check("question stays active after the former limit", st["round"]["status"] == "active" and st["round"]["elapsedSeconds"] >= 690 and st["rounds"] == [{"round": 1, "status": "solved"}], st)
        round_two = {"language": "python", "code": SOLUTIONS["balanced-brackets"]["python"]}
        r = await call("POST", "/api/arena/run", ada, json=round_two)
        check("sample runs remain available after the former limit", r.status_code == 200 and r.json()["result"] == "passed", r.text)
        r = await call("POST", "/api/arena/submit", ada, json=round_two)
        sub = r.json()
        check("late correct submission is accepted with uncapped scoring time", r.status_code == 200 and sub["result"] == "accepted" and sub["participant"]["roundPts"] == 200 and sub["participant"]["totalTimeMs"] >= 690_000, sub)

        print("\n[multi-session + proctoring]")
        await call("GET", "/api/arena/state", ada, tab="tab-B")
        alerts = (await call("GET", "/api/admin/alerts", root)).json()
        check("a second tab raises a high-severity MULTI_SESSION alert", any(a["type"] == "MULTI_SESSION" and a["severity"] == "high" and a["player"] == "Ada Lovelace" for a in alerts), alerts)
        check("tab switch report accepted", (await call("POST", "/api/proctor/events", ada, json={"type": "TAB_SWITCH", "seconds": 14})).status_code == 204)
        check("proctor event with bad type is rejected", (await call("POST", "/api/proctor/events", ada, json={"type": "NOPE"})).status_code == 422)
        alerts = (await call("GET", "/api/admin/alerts", root)).json()
        tab = next(a for a in alerts if a["type"] == "TAB_SWITCH")
        check("alert text is generated server-side", tab["detail"] == "Tab lost focus for 14s" and tab["round"] == 2, tab)
        await call("POST", f"/api/admin/alerts/{tab['id']}/ack", root)
        ov = (await call("GET", "/api/admin/overview", root)).json()
        check("overview counts open alerts", ov["openAlerts"] >= 1 and ov["playing"] == 1, ov)
        await call("POST", "/api/admin/alerts/ack-all", root)
        check("ack-all clears open count", (await call("GET", "/api/admin/overview", root)).json()["openAlerts"] == 0)
        await call("DELETE", f"/api/admin/alerts/{tab['id']}", root)
        check("dismissed alerts disappear", all(a["id"] != tab["id"] for a in (await call("GET", "/api/admin/alerts", root)).json()))

        print("\n[bob: concurrency + leaderboard]")
        await call("POST", "/api/arena/start", bob)
        # Fire three identical accepted submissions at once; exactly one may score.
        results = await asyncio.gather(*[call("POST", "/api/arena/submit", bob, json=good) for _ in range(3)])
        codes = sorted(r.status_code for r in results)
        bob_state = (await call("GET", "/api/arena/state", bob)).json()
        check("parallel submits score exactly once", bob_state["participant"]["roundPts"] == 100, (codes, bob_state["participant"]))
        check("others were rejected cleanly (429/409)", all(c in (200, 409, 429) for c in codes), codes)

        lb = (await call("GET", "/api/leaderboard", ada)).json()
        names = [e["name"] for e in lb["entries"]]
        check("leaderboard ranks by points then time", lb["total"] == 2 and names[0] == "Ada Lovelace" and lb["entries"][0]["total"] == 250 and lb["entries"][1]["total"] == 100, lb["entries"])
        check("leaderboard marks the viewer", [e["self"] for e in lb["entries"]] == [True, False], lb["entries"])
        check("anonymous leaderboard has no self flag", not any(e["self"] for e in (await call("GET", "/api/leaderboard")).json()["entries"]))
        check("limit param", len((await call("GET", "/api/leaderboard?limit=1")).json()["entries"]) == 1)

        print("\n[ada finishes the remaining rounds]")
        order = ["max-subarray-sum", "balanced-brackets", "climbing-stairs", "pair-sum-window", "longest-unique-substring",
                 "rotate-array", "coin-change", "longest-increasing-subsequence", "trapping-rain-water", "subarray-sum-equals-k"]
        for n in range(3, 11):
            st = (await call("POST", "/api/arena/start", ada, tab="tab-B")).json()
            assert st["round"]["round"] == n, st
            code = SOLUTIONS[order[n - 1]]["python"]
            sub = (await call("POST", "/api/arena/submit", ada, json={"language": "python", "code": code})).json()
            check(f"round {n} ({order[n-1]}) accepted {sub.get('passed')}/{sub.get('total')}", sub.get("result") == "accepted", sub)
        st = (await call("GET", "/api/arena/state", ada)).json()
        check("finishing round 10 finishes the player", st["finished"] and st["participant"]["status"] == "finished" and st["participant"]["roundPts"] == 1000, st["participant"])
        r = await call("POST", "/api/arena/start", ada)
        check("no round 11", r.status_code == 200 and r.json()["finished"], r.text)

        print("\n[admin ends the event]")
        await call("POST", "/api/arena/start", bob)  # bob moves to round 2 and is mid-round when the event ends
        check("admin ends the event", (await call("POST", "/api/admin/event/end", root)).status_code == 204)
        st = (await call("GET", "/api/arena/state", bob)).json()
        check("bob (mid-run) is finalised, active round closed", st["finished"] and st["eventStatus"] == "ended" and st["round"]["round"] == 2 and st["round"]["status"] == "expired" and st["participant"]["roundPts"] == 100, st)
        res = (await call("GET", "/api/results/me", ada)).json()
        check("results: totals, solved rounds and distractions", res["total"] == 1050 and res["bonus"] == 50 and res["solved"] == 10 and res["rounds"] == [1] * 10, res)
        check("results: name is real, time formatted", res["fullName"] == "Ada Lovelace" and len(res["timeTaken"]) == 8, res)
        r = await call("POST", "/api/participant/join", root)
        check("joining after the end is refused", r.status_code == 409, r.text)
        check("event cannot be ended twice", (await call("POST", "/api/admin/event/end", root)).status_code == 409)
    finally:
        await client.aclose()
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM auth.users WHERE email LIKE $1", f"e2e-%@{DOMAIN}")
            await conn.execute("UPDATE public.event_config SET status='lobby', started_at=NULL, ended_at=NULL")
            left = await conn.fetchval("SELECT count(*) FROM public.profiles WHERE email LIKE $1", f"e2e-%@{DOMAIN}")
        if pdf:
            from app.seed.loader import seed_rows
            from app.seed.pdf_import import build_rows, parse_questions

            async with db.acquire() as conn:
                await seed_rows(conn, build_rows(parse_questions(pdf), trust_oracle=True)[0])
            print("restored the event question set from the PDF")
        else:
            print("NOTE: the demo problem set is still loaded; re-seed with: python -m app.cli seed --pdf <file> --trust-oracle")
        event_service.invalidate()
        await judge_client.close()
        await db.close()
        print(f"\ncleanup: test users remaining = {left}; event reset to lobby")

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None)))
