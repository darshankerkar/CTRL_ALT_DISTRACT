"""Request/response models. The wire format is camelCase to match the frontend."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ------------------------------------------------------------------ event


class LanguageInfo(CamelModel):
    id: str
    label: str
    file: str


class EventInfo(CamelModel):
    status: Literal["lobby", "live", "ended"]
    started_at: int | None
    ended_at: int | None
    server_time: int
    name: str
    organizer_name: str
    college_name: str
    event_date: str
    event_time: str
    total_rounds: int
    round_seconds: None = None  # legacy fields: coding rounds have no time limit
    round_minutes: None = None
    dsa_points: int
    bonus_points: int
    distraction_seconds: int
    languages: list[LanguageInfo]


# ------------------------------------------------------------------ participant


class ParticipantSummary(CamelModel):
    status: Literal["joined", "playing", "finished"]
    current_round: int
    round_pts: int
    bonus_pts: int
    total_pts: int
    solved_count: int
    total_time_ms: int
    distractions_cleared: int
    distractions_total: int


class MeResponse(CamelModel):
    id: str
    email: str | None
    full_name: str
    role: Literal["participant", "admin"]
    player_code: str
    participation: ParticipantSummary | None


class LobbyPlayer(CamelModel):
    id: str
    name: str
    initials: str


class LobbyResponse(CamelModel):
    count: int
    players: list[LobbyPlayer]


class ResultsResponse(CamelModel):
    full_name: str
    total: int
    round_pts: int
    bonus: int
    solved: int
    time_taken: str
    distractions_cleared: int
    distractions_total: int
    rounds: list[int]  # 1 = solved, 0 = not solved, one entry per round


# ------------------------------------------------------------------ arena


class Example(CamelModel):
    input: str
    output: str
    explanation: str = ""


class SampleCase(CamelModel):
    input: str
    expected: str


class ProblemPublic(CamelModel):
    round: int
    title: str
    difficulty: Literal["EASY", "MEDIUM", "HARD"]
    points: int
    tags: list[str]
    description: list[str]
    input_format: str
    output_format: str
    examples: list[Example]
    constraints: list[str]
    hints: list[str]
    samples: list[SampleCase]
    starter_code: dict[str, str]


class DistractionStatus(CamelModel):
    state: Literal["pending", "active", "cleared", "missed"]
    at_seconds: int  # active seconds into the round at which it fires
    index: int  # 1-based index into the frontend's distraction registry
    remaining_seconds: int | None = None  # only while active


class RoundInfo(CamelModel):
    round: int
    status: Literal["active", "solved", "expired"]
    elapsed_seconds: int
    distraction: DistractionStatus


class RoundResult(CamelModel):
    round: int
    status: Literal["solved", "expired"]


class ArenaState(CamelModel):
    event_status: Literal["lobby", "live", "ended"]
    finished: bool
    participant: ParticipantSummary
    rounds: list[RoundResult]
    round: RoundInfo | None
    server_time: int


class QuestionItem(CamelModel):
    round: int
    title: str
    difficulty: Literal["EASY", "MEDIUM", "HARD"]
    points: int
    status: Literal["solved", "unsolved"]
    description: str
    in_progress: bool


class QuestionsResponse(CamelModel):
    items: list[QuestionItem]
    participant: ParticipantSummary
    event_status: Literal["lobby", "live", "ended"]
    finished: bool


class SelectQuestionRequest(CamelModel):
    round: int = Field(ge=1)


class CodeRequest(CamelModel):
    language: str = Field(min_length=1, max_length=16)
    code: str = Field(max_length=200_000)
    round: int | None = Field(default=None, ge=1)


class CompileOut(CamelModel):
    message: str
    line: int | None
    file: str


class CaseOut(CamelModel):
    index: int
    input: str
    expected: str
    actual: str | None
    status: Literal["pass", "fail", "error", "tle", "not_run"]
    message: str | None = None


class RunResponse(CamelModel):
    round: int
    result: Literal["passed", "failed", "compile-error"]
    passed: int
    total: int
    cases: list[CaseOut]
    compile: CompileOut | None
    runtime_ms: int | None
    memory_kb: int | None


class SubmitResponse(CamelModel):
    round: int
    result: Literal["accepted", "wrong", "compile-error", "expired"]
    headline: str
    passed: int
    total: int
    compile: CompileOut | None
    runtime_ms: int | None
    memory_kb: int | None
    participant: ParticipantSummary


class DistractionResolveRequest(CamelModel):
    round: int | None = Field(default=None, ge=1)
    result: Literal["passed", "failed", "timeout"]
    time_taken: int = Field(ge=0, le=3600)
    distraction_id: str | None = Field(default=None, max_length=40)
    metrics: dict[str, Any] | None = None


class DistractionStartRequest(CamelModel):
    round: int | None = Field(default=None, ge=1)


class DistractionResolveResponse(CamelModel):
    cleared: bool
    bonus: int
    participant: ParticipantSummary


# ------------------------------------------------------------------ proctoring


ProctorType = Literal["TAB_SWITCH", "FULLSCREEN_EXIT", "PASTE_BLOCKED", "MULTI_SESSION", "DISCONNECT"]


class ProctorEventRequest(CamelModel):
    type: ProctorType
    seconds: int | None = Field(default=None, ge=0, le=86_400)


class AlertOut(CamelModel):
    id: int
    type: ProctorType
    severity: Literal["high", "medium", "low"]
    player: str
    player_id: str
    round: int
    created_at: int
    detail: str
    acknowledged: bool


# ------------------------------------------------------------------ leaderboard / admin


class LeaderboardEntry(CamelModel):
    rank: int
    id: str
    name: str
    initials: str
    round_pts: int
    bonus: int
    total: int
    time: str
    self: bool = False


class LeaderboardResponse(CamelModel):
    entries: list[LeaderboardEntry]
    total: int
    event_status: Literal["lobby", "live", "ended"]


class AdminOverview(CamelModel):
    status: Literal["lobby", "live", "ended"]
    started_at: int | None
    ended_at: int | None
    server_time: int
    players: int
    playing: int
    finished: int
    open_alerts: int
    high_open_alerts: int


ApprovalStatus = Literal["pending", "approved", "rejected"]


class Registration(CamelModel):
    id: str
    full_name: str
    email: str
    approval_status: ApprovalStatus
    created_at: int
    reviewed_at: int | None


class RegistrationCounts(CamelModel):
    pending: int
    approved: int
    rejected: int


class RegistrationsResponse(CamelModel):
    items: list[Registration]
    total: int
    counts: RegistrationCounts


class ReviewRegistrationRequest(CamelModel):
    decision: Literal["approved", "rejected"]


class BulkApproveRegistrationsRequest(CamelModel):
    ids: list[UUID] = Field(default_factory=list, max_length=10000)
    all_pending: bool = False
    search: str = Field(default="", max_length=100)
    excluded_ids: list[UUID] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def validate_selection(self):
        if self.all_pending:
            if self.ids:
                raise ValueError("Choose all pending or explicit IDs, not both.")
        elif not self.ids or self.excluded_ids or self.search:
            raise ValueError("Select registration IDs, or use all pending with optional search/exclusions.")
        return self


class BulkApproveRegistrationsResponse(CamelModel):
    approved_count: int
