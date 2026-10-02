"""The competition arena: round state, problem, run/submit and distractions."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..schemas import (
    ArenaState,
    CodeRequest,
    DistractionResolveRequest,
    DistractionResolveResponse,
    DistractionStartRequest,
    ProblemPublic,
    QuestionsResponse,
    RunResponse,
    SelectQuestionRequest,
    SubmitResponse,
)
from ..security import AuthUser, client_id, current_user
from ..services import arena

router = APIRouter(prefix="/api/arena", tags=["arena"])
User = Annotated[AuthUser, Depends(current_user)]
Client = Annotated[str | None, Depends(client_id)]


@router.get("/state", response_model=ArenaState)
async def state(user: User, client: Client) -> ArenaState:
    return await arena.get_state(user.id, client)


@router.post("/start", response_model=ArenaState)
async def start(user: User, client: Client) -> ArenaState:
    """Resume the selected question, or begin the first remaining unsolved question."""
    return await arena.start_or_advance(user.id, client)


@router.get("/questions", response_model=QuestionsResponse)
async def questions(user: User) -> QuestionsResponse:
    return await arena.questions(user.id)


@router.post("/select", response_model=ArenaState)
async def select_question(body: SelectQuestionRequest, user: User, client: Client) -> ArenaState:
    return await arena.select_question(user.id, body.round, client)


@router.post("/exit", response_model=ArenaState)
async def exit_challenge(user: User) -> ArenaState:
    """End your participation and preserve your earned score on the leaderboard."""
    return await arena.exit_challenge(user.id)


@router.get("/problem", response_model=ProblemPublic)
async def problem(user: User, round: Annotated[int | None, Query(ge=1)] = None) -> ProblemPublic:
    return await arena.current_problem(user.id, round)


@router.post("/run", response_model=RunResponse)
async def run(body: CodeRequest, user: User) -> RunResponse:
    return await arena.run(user.id, body)


@router.post("/submit", response_model=SubmitResponse)
async def submit(body: CodeRequest, user: User) -> SubmitResponse:
    return await arena.submit(user.id, body)


@router.post("/distraction/start", response_model=ArenaState)
async def distraction_start(user: User, body: DistractionStartRequest | None = None) -> ArenaState:
    return await arena.distraction_start(user.id, body.round if body is not None else None)


@router.post("/distraction/resolve", response_model=DistractionResolveResponse)
async def distraction_resolve(body: DistractionResolveRequest, user: User) -> DistractionResolveResponse:
    return await arena.distraction_resolve(user.id, body)
