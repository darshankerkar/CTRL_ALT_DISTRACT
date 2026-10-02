<div align="center">

# Ctrl Alt Distract

<kbd>CTRL</kbd> <kbd>ALT</kbd> <kbd>DISTRACT</kbd>

**Solve the problem. Survive the distraction.**

A live DSA competition with code judging and surprise mini-games.

[Setup](#local-setup) · [Accounts](#participant-and-admin-access) · [Run an event](#running-an-event) · [Routes](#routes) · [Checks](#development-checks)

</div>

---

## What it does

- **Coding arena:** solve problems in Python, C++, C, or Java with sample runs and judged submissions.
- **Coding rounds:** questions have no individual time limit; the server tracks elapsed coding time, progress, and scores across refreshes.
- **Question selection:** **All questions** lists the participant's assigned questions with Status and Difficulty filters. **Previous** and **Next** in the arena move between unsolved questions and preserve saved drafts.
- **Distraction mini-games:** random interruptions pause elapsed coding time while players complete a timed challenge.
- **Live competition:** a shared lobby, event countdown, leaderboard, and results page.
- **Admin console:** approve or reject participant registrations, control the event, review proctoring alerts, and reset an ended event.
- **Arcade interface:** dark panels, pixel typography, and the CTRL / ALT / DISTRACT keycap logo.

The default format is ten rounds. Event settings and the problem pool are configured in the database.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 |
| Backend | FastAPI, asyncpg |
| Database & authentication | Supabase Postgres, Auth, Realtime |
| Code execution | Judge0 — Python, C++, C, Java |

## Local setup

You need Node.js and npm compatible with the project's Vite version, Python (the backend Docker image uses 3.12), a Supabase project, and access to Judge0.

### 1. Configure the environment

From the repository root, copy the example files. Both `.env` files are gitignored.

```powershell
# Windows PowerShell
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
```

On macOS or Linux, use `cp` instead of `Copy-Item`.

| File | Configuration |
| --- | --- |
| `.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` |
| `backend/.env` | `SUPABASE_URL`, `DATABASE_URL`, `CORS_ORIGINS`, and Judge0 settings |

Set `VITE_API_URL` to `http://localhost:8000` for local development. Use the same Supabase project for the frontend and backend, and include your frontend origin in `CORS_ORIGINS`.

Use the Supabase **session pooler** connection string for `DATABASE_URL` on networks without IPv6 access. URL-encode special characters in the database password, such as `@` → `%40`. Keep database credentials and service keys in the backend environment only.

### 2. Start the backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m app.cli migrate
python -m app.cli seed --pdf "<Coding Solutions>.pdf" --trust-oracle --rounds 10
uvicorn app.main:app --reload
```

On macOS or Linux, activate the environment with `source .venv/bin/activate`.

The seed command imports the organisers' question PDF. For a demo problem set, use `python -m app.cli seed --demo` instead. See [Problem content](#problem-content) for import behavior.

### 3. Start the frontend

Open another terminal at the repository root:

```bash
npm ci
npm run dev
```

| Service | Default local address |
| --- | --- |
| Website | http://localhost:5173 |
| Backend | http://localhost:8000 |
| API documentation | http://localhost:8000/docs — development only |

Use the URL printed by Vite if port 5173 is already occupied.

<details>
<summary><strong>Run the backend with Docker</strong></summary>

After configuring `backend/.env`, run this from the repository root:

```bash
docker compose up --build
```

This starts the backend on port 8000. Database migrations, problem seeding, and the frontend are separate setup steps.

</details>

## Participant and admin access

Both roles use the **same `/login` page**. There is no separate admin signup form or built-in admin password.

| Action | Behavior |
| --- | --- |
| Create an account | Creates a pending registration using full name, email, and password; no dashboard access yet |
| Sign in as an approved participant | Opens `/dashboard` |
| Sign in while pending or rejected | Blocked until the account is approved |
| Sign in as an admin | Opens `/admin` |
| Open `/admin` as a participant | Redirects to `/dashboard`; backend admin endpoints also reject access |

To make an admin, first create the account through the website. Then run this from `backend/`, with the Python environment activated:

```bash
python -m app.cli make-admin "you@example.com"
```

Sign out and sign in again to refresh the account's authentication role. The command updates both the database profile and Supabase app metadata; backend admin access is checked against the database.

In `/admin`, **Account approvals** shows pending registrations and reviewed accounts. Admins can search by name or email, approve requests, or reject them with confirmation. **Select all** includes pending registrations across every page and respects the search filter; individual checkboxes let admins exclude accounts. **Approve selected** approves the selection in one action and enables sign-in. Bulk approval skips registrations already reviewed by another admin. Decisions record the reviewer and time; a registration can be reviewed only once.

Apply `python -m app.cli migrate` before running the updated app. Migration `008_registration_approval.sql` keeps existing accounts approved and makes future participant registrations pending. A database trigger synchronizes registration status with Supabase's sign-in block. The backend also checks approval on every protected request, so an old token cannot bypass a pending or rejected status. Participants cannot change their own approval or role.

Email confirmation and admin approval are separate. The local configuration and existing migrations automatically confirm email addresses, but participant sign-in still requires admin approval. Signup clears its initial session and displays the waiting-for-approval message.

To use a participant and admin at the same time, open separate browser profiles, another browser, or a normal window plus a private window. Tabs in one browser session share the signed-in account.

## Running an event

1. **Register and approve:** participants create accounts; an admin reviews them under **Account approvals**.
2. **Join:** approved participants sign in, read the rulebook through **Rules**, tick the dashboard checklist, and join the lobby.
3. **Start:** an admin opens `/admin` and selects **Start event**. Players see the countdown before entering the arena.
4. **Play:** **All questions** lets participants choose their assigned questions in any order. Switching preserves each question's draft, active solving time, and interruption schedule. Correct submissions return to the list to choose another question. **Exit challenge** ends their participation after confirmation; earned points, submission history, and leaderboard results are retained.
5. **Finish:** **End event** closes active rounds and sends players to their results.
6. **Reset:** after the event ends, **Reset event** clears participation, attempts, submissions, and alerts, then reopens the lobby. Registration approvals are preserved.

## Architecture

```text
Browser ── JWT ──► FastAPI ── asyncpg ──► Supabase Postgres
   │                  │
   │                  └── HTTPS ──► Judge0
   ├── Authentication ────────────► Supabase Auth
   └── Event status updates ──────► Supabase Realtime
```

- **Server-owned state:** elapsed coding time, scoring, and round assignments are computed on the backend. Distractions pause elapsed coding time server-side. Questions stay open until solved, the participant exits, or the organiser ends the event; elapsed time remains available for leaderboard tie-breaks.
- **Consistent scoring:** scoring operations lock the player's database row to prevent duplicate scoring from concurrent requests.
- **Persistent selection:** apply migration `009_question_selection.sql` before using question selection. Inactive questions pause their accumulated solving time; an active or due interruption must be completed before switching. Participation finishes after all questions are solved, the participant exits, or the event ends.
- **Two judging modes:** `io` runs complete programs and compares stdout; `function` wraps a player's solution in a generated driver. **Run** uses samples; **Submit** also uses hidden tests.
- **Protected competition data:** the browser uses the API for gameplay data and mutations. Profiles have role-based access policies, and `event_config` allows authenticated reads for Realtime. Hidden tests remain on the server.

### Project layout

```text
src/                  React pages, components, contexts, and API client
backend/app/          API routes, services, authentication, and judging
backend/tests/        Offline tests and live integration checks
supabase/migrations/  Database schema, roles, and competition settings
```

Design tokens are defined in `src/index.css` under `@theme`.

## Problem content

The PDF importer reads problem statements, examples, hidden cases, and solutions at seed time. It checks the PDF's expected outputs against its solutions and reports contradictions. `--trust-oracle` uses the statement-consistent answer when those sources disagree.

Each player receives a random selection and order from the question pool. `--rounds N` sets how many questions they play. The assignment is saved when they join, so rejoining does not redraw it. Seeding is refused once anyone has played.

- `backend/app/seed/pdf_import.py` contains the PDF parser and problem metadata.
- `backend/app/seed/problems.py` contains the function-style demo set.
- `event_config` stores scoring, distraction timing, and organiser settings. Its legacy `round_seconds` column is retained for existing databases and is not used to limit questions.

### Judge0 configuration

The backend defaults to `https://ce.judge0.com`. For a hosted or self-hosted instance, configure `JUDGE0_URL`, `JUDGE0_API_KEY`, and `JUDGE0_API_KEY_HEADER` in `backend/.env`. RapidAPI setups also use `JUDGE0_API_HOST`. Language IDs and time multipliers are stored in the `languages` table.

## Routes

| Route | Page | Access |
| --- | --- | --- |
| `/` | Redirects to `/login` | Public |
| `/login` | Shared sign-in and participant signup | Public |
| `/rules` | Rulebook | Public |
| `/leaderboard` | Competition standings | Public |
| `/dashboard` | Event entry and player progress | Signed in |
| `/lobby` | Player roster and countdown | Signed in |
| `/arena` | Problem, editor, judging, and distractions | Signed in |
| `/questions` | Assigned questions with Status and Difficulty filters | Signed in |
| `/complete` | Player results | Signed in |
| `/admin` | Account approvals, event controls, alerts, and top players | Admin |

## Development checks

From the repository root:

```bash
npm run build
npm run lint
```

From `backend/`, with the Python environment activated:

| Command | Purpose |
| --- | --- |
| `python -m pytest` | Offline protocol, harness, evaluator, and JWT tests |
| `RUN_SELECTION_DB_TESTS=1 python -m pytest tests/test_question_selection_postgres.py` | Opt-in question selection and scoring checks using session-local temporary database tables (PowerShell: set `$env:RUN_SELECTION_DB_TESTS='1'` first) |
| `python -m tests.live_judge_check` | Demo solutions across languages on Judge0 |
| `python -m tests.live_io_check "<questions>.pdf"` | PDF solutions on Judge0; add `--seeded` to use stored tests |
| `python -m tests.e2e_io "<questions>.pdf"` | Full API flow with the event's problem set |
| `python -m tests.e2e_flow "<questions>.pdf"` | Full API flow using demo problems, then restore the event set |
| `python -m app.cli status` | Current event state and database row counts |
| `python -m tests.live_registration_check` | Real signup, approval/rejection, Supabase login, API access, and self-approval/concurrency checks using temporary accounts |

Live checks need the configured database and/or Judge0. The end-to-end scripts create and delete test users and refuse to run if real participants exist. The demo flow temporarily replaces the problem set.

`backend/tests/ui_harness.py` provides a development-only API harness with token verification replaced for UI testing.
