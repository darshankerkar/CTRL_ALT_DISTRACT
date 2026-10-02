// Wire types for the backend API (backend/app/schemas.py). Keep the two in sync.

export type EventStatus = "lobby" | "live" | "ended";
export type ParticipantStatus = "joined" | "playing" | "finished";
export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export type LanguageId = "python" | "cpp" | "c" | "java";

export interface LanguageInfo {
  id: LanguageId;
  label: string;
  file: string;
}

export interface EventInfo {
  status: EventStatus;
  startedAt: number | null;
  endedAt: number | null;
  serverTime: number;
  name: string;
  organizerName: string;
  collegeName: string;
  eventDate: string;
  eventTime: string;
  totalRounds: number;
  roundSeconds: number | null;
  roundMinutes: number | null;
  dsaPoints: number;
  bonusPoints: number;
  distractionSeconds: number;
  languages: LanguageInfo[];
}

export interface ParticipantSummary {
  status: ParticipantStatus;
  currentRound: number;
  roundPts: number;
  bonusPts: number;
  totalPts: number;
  solvedCount: number;
  totalTimeMs: number;
  distractionsCleared: number;
  distractionsTotal: number;
}

export interface Me {
  id: string;
  email: string | null;
  fullName: string;
  role: "participant" | "admin";
  playerCode: string;
  participation: ParticipantSummary | null;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  initials: string;
}

export interface Lobby {
  count: number;
  players: LobbyPlayer[];
}

export interface Results {
  fullName: string;
  total: number;
  roundPts: number;
  bonus: number;
  solved: number;
  timeTaken: string;
  distractionsCleared: number;
  distractionsTotal: number;
  rounds: number[];
}

export interface Example {
  input: string;
  output: string;
  explanation: string;
}

export interface SampleCase {
  input: string;
  expected: string;
}

export interface Problem {
  round: number;
  title: string;
  difficulty: Difficulty;
  points: number;
  tags: string[];
  description: string[];
  inputFormat: string;
  outputFormat: string;
  examples: Example[];
  constraints: string[];
  hints: string[];
  samples: SampleCase[];
  starterCode: Record<LanguageId, string>;
}

export type DistractionState = "pending" | "active" | "cleared" | "missed";

export interface RoundInfo {
  round: number;
  status: "active" | "solved" | "expired";
  elapsedSeconds: number;
  distraction: {
    state: DistractionState;
    atSeconds: number;
    index: number;
    remainingSeconds: number | null;
  };
}

export interface ArenaState {
  eventStatus: EventStatus;
  finished: boolean;
  participant: ParticipantSummary;
  rounds: Array<{ round: number; status: "solved" | "expired" }>;
  round: RoundInfo | null;
  serverTime: number;
}

export interface ArenaQuestion {
  round: number;
  title: string;
  difficulty: Difficulty;
  points: number;
  status: "solved" | "unsolved";
  description: string;
  inProgress: boolean;
}

export interface ArenaQuestionsResponse {
  items: ArenaQuestion[];
  participant: ParticipantSummary;
  eventStatus: EventStatus;
  finished: boolean;
}

export interface CompileInfo {
  message: string;
  line: number | null;
  file: string;
}

export interface CaseResult {
  index: number;
  input: string;
  expected: string;
  actual: string | null;
  status: "pass" | "fail" | "error" | "tle" | "not_run";
  message: string | null;
}

export interface RunResponse {
  round: number;
  result: "passed" | "failed" | "compile-error";
  passed: number;
  total: number;
  cases: CaseResult[];
  compile: CompileInfo | null;
  runtimeMs: number | null;
  memoryKb: number | null;
}

export interface SubmitResponse {
  round: number;
  result: "accepted" | "wrong" | "compile-error" | "expired";
  headline: string;
  passed: number;
  total: number;
  compile: CompileInfo | null;
  runtimeMs: number | null;
  memoryKb: number | null;
  participant: ParticipantSummary;
}

export interface DistractionResolveBody {
  round?: number;
  result: "passed" | "failed" | "timeout";
  timeTaken: number;
  distractionId?: string;
  metrics?: Record<string, string | number | boolean>;
}

export interface DistractionResolveResponse {
  cleared: boolean;
  bonus: number;
  participant: ParticipantSummary;
}

export type ProctorType = "TAB_SWITCH" | "FULLSCREEN_EXIT" | "PASTE_BLOCKED" | "MULTI_SESSION" | "DISCONNECT";
export type Severity = "high" | "medium" | "low";

export interface Alert {
  id: number;
  type: ProctorType;
  severity: Severity;
  player: string;
  playerId: string;
  round: number;
  createdAt: number;
  detail: string;
  acknowledged: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  initials: string;
  roundPts: number;
  bonus: number;
  total: number;
  time: string;
  self: boolean;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total: number;
  eventStatus: EventStatus;
}

export interface AdminOverview {
  status: EventStatus;
  startedAt: number | null;
  endedAt: number | null;
  serverTime: number;
  players: number;
  playing: number;
  finished: number;
  openAlerts: number;
  highOpenAlerts: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Registration {
  id: string;
  fullName: string;
  email: string;
  approvalStatus: ApprovalStatus;
  createdAt: number;
  reviewedAt: number | null;
}

export interface RegistrationsResponse {
  items: Registration[];
  total: number;
  counts: Record<ApprovalStatus, number>;
}
