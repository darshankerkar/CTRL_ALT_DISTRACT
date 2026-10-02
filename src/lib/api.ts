import { supabase } from "./supabase";
import type {
  AdminOverview,
  ApprovalStatus,
  Alert,
  ArenaState,
  ArenaQuestionsResponse,
  DistractionResolveBody,
  DistractionResolveResponse,
  EventInfo,
  LeaderboardResponse,
  Lobby,
  Me,
  Problem,
  ProctorType,
  Results,
  Registration,
  RegistrationsResponse,
  RunResponse,
  SubmitResponse,
} from "./types";

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** The request never reached the server (offline, DNS, server down). */
  get isNetwork() {
    return this.status === 0;
  }
}

/** One id per browser tab; the server uses it to notice the same account playing in two places. */
export const clientId = (() => {
  const fresh = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  try {
    const existing = sessionStorage.getItem("cad-client");
    if (existing) return existing;
    const id = fresh();
    sessionStorage.setItem("cad-client", id);
    return id;
  } catch {
    return fresh();
  }
})();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Client-Id": clientId };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const { data } = await supabase.auth.getSession();
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server.");
  }
  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error ?? (res.status === 422 ? "invalid_request" : "error"),
      json?.message ?? (res.status === 422 ? "That request was not valid." : `Request failed (${res.status}).`),
    );
  }
  return json as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});

export const api = {
  event: () => get<EventInfo>("/api/event"),
  me: () => get<Me>("/api/me"),
  join: () => post<void>("/api/participant/join"),
  leave: () => post<void>("/api/participant/leave"),
  lobby: () => get<Lobby>("/api/lobby"),
  results: () => get<Results>("/api/results/me"),
  leaderboard: (limit?: number) =>
    get<LeaderboardResponse>(`/api/leaderboard${limit ? `?limit=${limit}` : ""}`),
  reportProctor: (type: ProctorType, seconds?: number) =>
    post<void>("/api/proctor/events", { type, seconds }),

  arena: {
    state: () => get<ArenaState>("/api/arena/state"),
    start: () => post<ArenaState>("/api/arena/start"),
    exit: () => post<ArenaState>("/api/arena/exit"),
    questions: () => get<ArenaQuestionsResponse>("/api/arena/questions"),
    select: (round: number) => post<ArenaState>("/api/arena/select", { round }),
    problem: (round?: number) => get<Problem>(`/api/arena/problem${round ? `?round=${round}` : ""}`),
    run: (language: string, code: string, round?: number) => post<RunResponse>("/api/arena/run", { language, code, round }),
    submit: (language: string, code: string, round?: number) => post<SubmitResponse>("/api/arena/submit", { language, code, round }),
    distractionStart: (round?: number) => post<ArenaState>("/api/arena/distraction/start", { round }),
    distractionResolve: (body: DistractionResolveBody) =>
      post<DistractionResolveResponse>("/api/arena/distraction/resolve", body),
  },

  admin: {
    registrations: (status: ApprovalStatus, search = "", offset = 0) =>
      get<RegistrationsResponse>(`/api/admin/registrations?${new URLSearchParams({ status, search, offset: String(offset), limit: "20" })}`),
    approveRegistrations: (selection: { ids: string[]; allPending: boolean; search: string; excludedIds: string[] }) =>
      post<{ approvedCount: number }>("/api/admin/registrations/approve", selection),
    reviewRegistration: (id: string, decision: "approved" | "rejected") =>
      post<Registration>(`/api/admin/registrations/${encodeURIComponent(id)}/review`, { decision }),
    overview: () => get<AdminOverview>("/api/admin/overview"),
    startEvent: () => post<void>("/api/admin/event/start"),
    endEvent: () => post<void>("/api/admin/event/end"),
    resetEvent: () => post<void>("/api/admin/event/reset"),
    alerts: () => get<Alert[]>("/api/admin/alerts"),
    acknowledge: (id: number) => post<void>(`/api/admin/alerts/${id}/ack`),
    acknowledgeAll: () => post<void>("/api/admin/alerts/ack-all"),
    dismiss: (id: number) => request<void>("DELETE", `/api/admin/alerts/${id}`),
  },
};
