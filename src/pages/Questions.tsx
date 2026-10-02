import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, CircleAlert, ListFilter } from "lucide-react";
import { AppHeader } from "../components/headers/AppHeader";
import { Button, PixelSpinner } from "../components/ui/Button";
import { api, ApiError } from "../lib/api";
import type { ArenaQuestion, ArenaQuestionsResponse, Difficulty } from "../lib/types";
import { cn, difficultyClasses } from "../lib/utils";

type QuestionStatus = ArenaQuestion["status"];

function FilterCheckbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2 font-body text-[15px] text-text-secondary hover:text-text-primary">
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <input type="checkbox" checked={checked} onChange={onChange} className="peer h-5 w-5 cursor-pointer appearance-none rounded-xs border border-border-strong bg-bg-inset checked:border-success checked:bg-success" />
        <Check size={15} strokeWidth={3} aria-hidden="true" className="pointer-events-none absolute text-black opacity-0 peer-checked:opacity-100" />
      </span>
      {label}
    </label>
  );
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function Questions() {
  const navigate = useNavigate();
  const [data, setData] = useState<ArenaQuestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<QuestionStatus[]>([]);
  const [difficulties, setDifficulties] = useState<Difficulty[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mounted = useRef(false);
  const fetching = useRef(false);
  const selectionPending = useRef(false);

  const load = useCallback(async () => {
    if (fetching.current || selectionPending.current) return;
    fetching.current = true;
    try {
      // An active interruption must be completed in the arena before choosing a question.
      const state = await api.arena.state();
      if (!mounted.current) return;
      if (!state.finished && state.round?.distraction.state === "active") {
        navigate("/arena", { replace: true });
        return;
      }
      const next = await api.arena.questions();
      if (!mounted.current || selectionPending.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (!mounted.current || selectionPending.current) return;
      if (err instanceof ApiError && ["not_joined", "participation_required"].includes(err.code)) {
        navigate("/dashboard", { replace: true });
        return;
      }
      setError(err instanceof ApiError && !err.isNetwork ? err.message : "Could not load your questions. Check your connection and try again.");
    } finally {
      fetching.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const items = useMemo(() => (data?.items ?? []).filter((question) =>
    (!statuses.length || statuses.includes(question.status)) &&
    (!difficulties.length || difficulties.includes(question.difficulty)),
  ), [data?.items, statuses, difficulties]);
  const current = data?.items.find((question) => question.round === data.participant.currentRound && question.inProgress && question.status === "unsolved");
  const canSelect = !!data && !data.finished && data.eventStatus === "live";

  async function selectQuestion(question: ArenaQuestion) {
    if (!canSelect || question.status === "solved" || selectionPending.current) return;
    selectionPending.current = true;
    setSelecting(question.round);
    setError(null);
    try {
      const next = await api.arena.select(question.round);
      if (!mounted.current) return;
      if (next.finished) {
        navigate(next.eventStatus === "ended" ? "/complete?ended=1" : "/complete", { replace: true });
        return;
      }
      navigate("/arena");
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && ["distraction_active", "distraction_due"].includes(err.code)) {
        navigate("/arena", { replace: true });
        return;
      }
      setError(err instanceof ApiError && !err.isNetwork ? err.message : "Could not open this question. Your saved work is safe. Reconnect and try again.");
    } finally {
      selectionPending.current = false;
      if (mounted.current) setSelecting(null);
    }
  }

  function clearFilters() {
    setStatuses([]);
    setDifficulties([]);
  }

  return (
    <div className="min-h-screen bg-bg-canvas">
      <AppHeader eventState={data?.finished ? "finished" : data?.eventStatus === "live" ? "live" : data?.eventStatus === "ended" ? "ended" : "joined"} />
      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-8 sm:py-12">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-5">
          <div>
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.14em] text-accent-cyan">Competition challenges</p>
            <h1 className="font-display text-4xl text-text-primary sm:text-5xl">All questions</h1>
            <p className="mt-3 font-body text-sm text-text-secondary">
              {data ? `${data.participant.solvedCount} of ${data.items.length} solved` : "Choose a question and code your solution."}
              {canSelect && " · Solve in any order"}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" size="sm" to="/dashboard" icon={<ArrowLeft size={14} />}>Dashboard</Button>
            {current && canSelect && <Button variant="secondary" size="sm" disabled={selecting !== null} onClick={() => void selectQuestion(current)} icon={<ArrowRight size={14} />}>Return to arena</Button>}
            {data?.finished && <Button variant="secondary" size="sm" to="/complete">My result</Button>}
          </div>
        </div>

        {error && (
          <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 border border-danger/40 bg-fill-danger px-4 py-3 text-danger">
            <CircleAlert size={18} className="shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 font-body text-sm">{error}</p>
            <Button variant="danger" size="sm" disabled={selecting !== null} onClick={() => { setLoading(!data); void load(); }}>Retry</Button>
          </div>
        )}
        {data && !canSelect && (
          <p className="mb-6 border border-border-default bg-bg-panel px-5 py-4 font-body text-sm text-text-secondary">
            {data.finished ? "Your participation has finished. Your scores and question statuses remain saved." : data.eventStatus === "ended" ? "The event has ended. Your scores and question statuses remain saved." : "You can open questions when the organizers start the event."}
          </p>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_250px] lg:gap-8">
          <aside className="border border-border-default bg-bg-panel p-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1" aria-label="Question filters">
            <button className="flex w-full items-center justify-between font-label text-lg uppercase text-text-primary lg:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
              Filters <ListFilter size={18} aria-hidden="true" />
            </button>
            <div className={cn("mt-5 lg:mt-0", !filtersOpen && "hidden lg:block")}>
              <fieldset>
                <legend className="mb-3 font-label text-lg uppercase tracking-[0.04em] text-text-muted">Status</legend>
                <FilterCheckbox label="Solved" checked={statuses.includes("solved")} onChange={() => setStatuses((values) => toggleValue(values, "solved"))} />
                <FilterCheckbox label="Unsolved" checked={statuses.includes("unsolved")} onChange={() => setStatuses((values) => toggleValue(values, "unsolved"))} />
              </fieldset>
              <div className="mt-6 border-t border-border-default pt-6">
                <fieldset>
                  <legend className="mb-3 font-label text-lg uppercase tracking-[0.04em] text-text-muted">Difficulty</legend>
                  {(["EASY", "MEDIUM", "HARD"] as const).map((difficulty) => (
                    <FilterCheckbox key={difficulty} label={difficulty.charAt(0) + difficulty.slice(1).toLowerCase()} checked={difficulties.includes(difficulty)} onChange={() => setDifficulties((values) => toggleValue(values, difficulty))} />
                  ))}
                </fieldset>
              </div>
              {(statuses.length > 0 || difficulties.length > 0) && <button onClick={clearFilters} className="mt-5 font-body text-sm text-accent-cyan hover:underline">Clear filters</button>}
            </div>
          </aside>

          <section className="min-w-0 lg:col-start-1 lg:row-start-1" aria-label="Competition questions" aria-busy={loading}>
            {loading && <div role="status" className="flex items-center justify-center gap-3 border border-border-default bg-bg-panel p-12 font-mono text-sm text-accent-cyan"><PixelSpinner /> Loading questions…</div>}
            {!loading && data && <p aria-live="polite" className="mb-4 font-mono text-xs text-text-muted">Showing {items.length} of {data.items.length} questions</p>}
            <div className="space-y-4">
              {items.map((question) => (
                <article key={question.round} className={cn("border border-border-default bg-bg-panel p-5 sm:p-7", question.inProgress && question.status !== "solved" && "border-l-2 border-l-accent-cyan")}>
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="mb-3 flex flex-wrap items-center gap-3">
                        <span className="font-mono text-xs text-text-muted">{question.round.toString().padStart(2, "0")}</span>
                        <span className={cn("inline-flex items-center gap-1 rounded-xs px-2 py-1 font-mono text-[11px]", question.status === "solved" ? "bg-fill-success text-success" : "bg-bg-elevated text-text-secondary")}>
                          {question.status === "solved" && <Check size={12} strokeWidth={3} aria-hidden="true" />}{question.status === "solved" ? "Solved" : "Unsolved"}
                        </span>
                        {question.inProgress && question.status === "unsolved" && <span className="font-mono text-[11px] text-accent-cyan">In progress</span>}
                      </div>
                      <h2 className="font-sans text-xl font-semibold text-text-primary sm:text-2xl">{question.title}</h2>
                      <div className="mt-3 flex flex-wrap items-center gap-3 font-body text-xs">
                        <span className={cn("rounded-xs px-2 py-1", difficultyClasses(question.difficulty))}>{question.difficulty.charAt(0) + question.difficulty.slice(1).toLowerCase()}</span>
                        <span className="font-mono text-accent-yellow">Max score: {question.points}</span>
                      </div>
                      <p className="mt-4 max-w-[65ch] font-body text-sm leading-relaxed text-text-secondary">{question.description}</p>
                    </div>
                    <Button variant={question.status === "solved" ? "secondary" : "primary"} size="md" className="w-full shrink-0 sm:w-auto" disabled={!canSelect || question.status === "solved" || selecting !== null} loading={selecting === question.round} loadingLabel="Opening…" onClick={() => void selectQuestion(question)}>
                      {question.status === "solved" ? "Solved" : question.inProgress ? "Resume challenge" : "Solve challenge"}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            {!loading && data && items.length === 0 && <div className="border border-border-default bg-bg-panel p-10 text-center"><p className="font-sans text-lg text-text-primary">No questions match these filters.</p><button className="mt-3 font-body text-sm text-accent-cyan hover:underline" onClick={clearFilters}>Show all questions</button></div>}
          </section>
        </div>
      </main>
    </div>
  );
}
