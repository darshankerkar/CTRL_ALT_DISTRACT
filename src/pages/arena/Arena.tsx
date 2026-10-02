import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ArenaHUD, type InterruptState } from "./ArenaHUD";
import { ProblemPanel } from "./ProblemPanel";
import { CodeEditor } from "./CodeEditor";
import { ResultPanel, type RunResult, type SubmitResult } from "./ResultPanel";
import { LockOverlay } from "./LockOverlay";
import { DistractionModal } from "./DistractionModal";
import { RoundTransition } from "./RoundTransition";
import { StatusBar } from "./StatusBar";
import { ResizeHandle } from "./ResizeHandle";
import { ExitChallengeDialog } from "./ExitChallengeDialog";
import { Button, PixelSpinner } from "../../components/ui/Button";
import { api, ApiError } from "../../lib/api";
import type { ArenaState, LanguageId, Problem, RunResponse, SubmitResponse } from "../../lib/types";
import type { DistractionResult } from "../../types/distraction";
import { cn } from "../../lib/utils";
import { useEvent } from "../../context/EventContext";
import { useAuth } from "../../context/AuthContext";
import { useMe } from "../../context/MeContext";

const SYNC_MS = 10_000; // state poll; doubles as the connectivity heartbeat
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Arena() {
  const navigate = useNavigate();
  const EVENT = useEvent();
  const { user } = useAuth();
  const { refresh: refreshMe } = useMe();
  const eventStatus = EVENT.status;

  // ---- server-owned state -------------------------------------------------------------------
  const [state, setState] = useState<ArenaState | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const lastServerTime = useRef(0);
  const participantFinished = useRef(false);
  const exitInProgress = useRef(false);
  const actionInProgress = useRef(false);
  const selectingQuestion = useRef(false);
  const [selectingRound, setSelectingRound] = useState<number | null>(null);
  const currentRoundRef = useRef<number | null>(null);
  const [editorReadyRound, setEditorReadyRound] = useState<number | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const round = state?.round?.round ?? Math.max(state?.participant.currentRound ?? 1, 1);
  const roundActive = state?.round?.status === "active";
  const score = state?.participant.totalPts ?? 0;
  const solvedRounds = state?.rounds.filter((r) => r.status === "solved").map((r) => r.round) ?? [];
  const expiredRounds = state?.rounds.filter((r) => r.status === "expired").map((r) => r.round) ?? [];
  const distractionCount = state?.participant.distractionsCleared ?? 0;
  const availableRounds = Array.from({ length: EVENT.totalRounds }, (_, index) => index + 1)
    .filter((number) => !state?.rounds.some((result) => result.round === number));
  const previousRound = availableRounds.filter((number) => number < round).pop() ?? null;
  const nextRound = availableRounds.find((number) => number > round) ?? null;

  const applyState = useCallback((next: ArenaState, force = false) => {
    if (!force && next.serverTime < lastServerTime.current) return; // an older response lost the race
    lastServerTime.current = next.serverTime;
    participantFinished.current = next.finished;
    currentRoundRef.current = next.round?.round ?? null;
    setState(next);
    if (next.round) setElapsedSeconds(next.round.elapsedSeconds);
  }, []);

  // ---- connectivity -------------------------------------------------------------------------
  const [connection, setConnection] = useState<"connected" | "reconnecting" | "offline">("connected");
  const [reconnected, setReconnected] = useState(false);
  const offlineSince = useRef<number | null>(null);
  const connectionRef = useRef(connection);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  const markOffline = useCallback(() => {
    if (offlineSince.current === null) offlineSince.current = Date.now();
    setConnection("offline");
    setReconnected(false);
  }, []);

  const markOnline = useCallback(() => {
    if (connectionRef.current !== "connected") {
      setConnection("connected");
      setReconnected(true);
      setTimeout(() => setReconnected(false), 2500);
    }
    if (offlineSince.current !== null) {
      const seconds = Math.round((Date.now() - offlineSince.current) / 1000);
      offlineSince.current = null;
      if (seconds >= 10) api.reportProctor("DISCONNECT", seconds).catch(() => undefined);
    }
  }, []);

  const syncState = useCallback(async () => {
    try {
      const next = await api.arena.state();
      if (!alive.current || selectingQuestion.current) return;
      applyState(next);
      markOnline();
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) markOffline();
    }
  }, [applyState, markOffline, markOnline]);

  useEffect(() => {
    const t = setInterval(() => void syncState(), SYNC_MS);
    const goOffline = () => markOffline();
    const goOnline = () => {
      setConnection("reconnecting");
      void syncState();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [syncState, markOffline]);

  // ---- UI state -----------------------------------------------------------------------------
  const [runResult, setRunResult] = useState<RunResult>("idle");
  const [submitResult, setSubmitResult] = useState<SubmitResult>("idle");
  const [runData, setRunData] = useState<RunResponse | null>(null);
  const [submitData, setSubmitData] = useState<SubmitResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [distraction, setDistraction] = useState<number | null>(null);
  const [interruptState, setInterruptState] = useState<InterruptState>("standby");

  const [transition, setTransition] = useState<{ variant: "clear" | "closed"; isFinal: boolean } | null>(null);
  const [resultH, setResultH] = useState(240);
  const [resultCollapsed, setResultCollapsed] = useState(false);
  const editorColRef = useRef<HTMLDivElement>(null);
  const [mobileTab, setMobileTab] = useState<"PROBLEM" | "CODE" | "RESULTS">("PROBLEM");

  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [focusLine, setFocusLine] = useState<{ line: number; nonce: number } | null>(null);
  const editorRef = useRef<{ code: string; language: LanguageId }>({ code: "", language: EVENT.languages[0].id });

  const resetRoundUi = useCallback(() => {
    setRunResult("idle");
    setSubmitResult("idle");
    setRunData(null);
    setSubmitData(null);
    setNotice(null);
    setErrorLine(null);
    setFocusLine(null);
    setInterruptState("standby");
    setDistraction(null);
    setEditorReadyRound(null);
  }, []);

  // ---- bootstrap: enter (or resume) the run -------------------------------------------------
  useEffect(() => {
    void (async () => {
      for (let attempt = 0; alive.current; attempt++) {
        try {
          const s = await api.arena.start();
          if (!alive.current) return;
          if (s.finished) {
            participantFinished.current = true;
            void refreshMe();
            navigate(s.eventStatus === "ended" ? "/complete?ended=1" : "/complete", { replace: true });
            return;
          }
          applyState(s, true);
          markOnline();
          if (s.round?.distraction.state === "active") {
            setDistraction(s.round.distraction.index);
            setInterruptState("active");
          }
          return;
        } catch (err) {
          if (err instanceof ApiError && !err.isNetwork) {
            // Not joined, or the event is not running: the dashboard explains and routes from there.
            navigate(err.code === "event_not_live" && eventStatus === "ended" ? "/complete?ended=1" : "/dashboard", { replace: true });
            return;
          }
          markOffline();
          await sleep(Math.min(1000 * (attempt + 1), 5000));
        }
      }
    })();
  }, [navigate, applyState, markOnline, markOffline, eventStatus, refreshMe]);

  // A second tab can finish participation. Never advance a finished player's round.
  useEffect(() => {
    if (!state?.finished || exitInProgress.current) return;
    void refreshMe();
    navigate(state.eventStatus === "ended" ? "/complete?ended=1" : "/complete", { replace: true });
  }, [state?.finished, state?.eventStatus, exiting, navigate, refreshMe]);

  // The problem for the round in progress.
  const activeRound = state?.round?.round;
  useEffect(() => {
    if (!activeRound) return;
    let cancelled = false;
    setProblem(null);
    resetRoundUi();
    editorRef.current = { code: "", language: EVENT.languages[0].id };
    const load = async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const p = await api.arena.problem(activeRound);
          if (!cancelled) setProblem(p);
          return;
        } catch {
          await sleep(Math.min(1000 * (attempt + 1), 5000));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeRound, resetRoundUi, EVENT.languages]);

  // Synchronize an interruption started or resolved in another tab as well.
  useEffect(() => {
    const serverDistraction = state?.round?.distraction;
    if (serverDistraction?.state === "active") {
      setDistraction(serverDistraction.index);
      setInterruptState("active");
    } else {
      setDistraction(null);
    }
  }, [activeRound, state?.round?.distraction]);

  // ---- event ended by the admin -------------------------------------------------------------
  const [eventEnded, setEventEnded] = useState(false);
  const prevEventStatus = useRef(eventStatus);
  useEffect(() => {
    const endedNow =
      (prevEventStatus.current === "live" && eventStatus === "ended") || state?.eventStatus === "ended";
    prevEventStatus.current = eventStatus;
    if (!endedNow || eventEnded) return;
    setEventEnded(true);
    const t = setTimeout(() => navigate("/complete?ended=1"), 2000);
    return () => clearTimeout(t);
  }, [eventStatus, state?.eventStatus, eventEnded, navigate]);

  // Active coding time only schedules distractions; questions have no countdown.
  useEffect(() => {
    const tick = setInterval(() => {
      if (!roundActive || distraction !== null || transition || exiting || state?.finished) return;
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [roundActive, distraction, transition, exiting, state?.finished]);

  // ---- round transitions (driven by the server's verdict on the round) ----------------------
  const transitioned = useRef(0);
  useEffect(() => {
    const r = state?.round;
    if (!r || r.status === "active" || transition || exitOpen || exiting || state?.finished || transitioned.current === r.round) return;
    const variant = r.status === "solved" ? "clear" : "closed";
    const closedRound = r.round;
    const t = setTimeout(
      () => {
        transitioned.current = closedRound;
        const isFinal = (state?.participant.solvedCount ?? 0) >= EVENT.totalRounds;
        setTransition({ variant, isFinal });
        if (variant === "closed") setSubmitResult("expired");
      },
      variant === "clear" ? 600 : 400,
    );
    return () => clearTimeout(t);
  }, [state?.round, state?.finished, state?.participant.solvedCount, transition, exitOpen, exiting, EVENT.totalRounds]);

  useEffect(() => {
    if (!transition || exitOpen || exiting || state?.finished) return;
    const timer = setTimeout(() => {
      if (!alive.current || exitInProgress.current || participantFinished.current) return;
      if (transition.isFinal) navigate("/complete");
      else navigate("/questions", { replace: true });
    }, transition.isFinal ? 1600 : 2000);
    return () => clearTimeout(timer);
  }, [transition, exitOpen, exiting, state?.finished, navigate]);

  // ---- run / submit -------------------------------------------------------------------------
  const busy =
    selectingRound !== null ||
    exitOpen ||
    exiting ||
    !!state?.finished ||
    eventEnded ||
    distraction !== null ||
    !!transition ||
    connection === "offline" ||
    !roundActive ||
    problem?.round !== round ||
    editorReadyRound !== round ||
    runResult === "running" ||
    submitResult === "submitting" ||
    submitResult === "accepted" ||
    submitResult === "expired";

  function handleActionError(err: unknown) {
    setRunResult("idle");
    setSubmitResult("idle");
    if (err instanceof ApiError) {
      if (err.isNetwork) {
        markOffline();
        return;
      }
      if (["round_closed", "event_not_live", "question_changed", "distraction_active"].includes(err.code)) void syncState();
      setNotice(err.message);
      return;
    }
    setNotice("Something went wrong. Please try again.");
  }

  async function handleRun() {
    if (busy || selectingQuestion.current || actionInProgress.current || exitInProgress.current || participantFinished.current) return;
    actionInProgress.current = true;
    const requestRound = round;
    const { code, language } = editorRef.current;
    setErrorLine(null);
    setNotice(null);
    setSubmitResult("idle"); // only the latest action's result is shown
    setSubmitData(null);
    setRunResult("running");
    try {
      const r = await api.arena.run(language, code, requestRound);
      if (!alive.current || participantFinished.current || exitInProgress.current) return;
      if (currentRoundRef.current !== requestRound || r.round !== requestRound) {
        void syncState();
        return;
      }
      setRunData(r);
      setRunResult(r.result);
      setErrorLine(r.compile?.line ?? null);
    } catch (err) {
      if (alive.current && currentRoundRef.current === requestRound && !participantFinished.current && !exitInProgress.current) handleActionError(err);
    } finally {
      actionInProgress.current = false;
    }
  }

  async function handleSubmit() {
    if (busy || selectingQuestion.current || actionInProgress.current || exitInProgress.current || participantFinished.current) return;
    actionInProgress.current = true;
    const requestRound = round;
    const { code, language } = editorRef.current;
    setErrorLine(null);
    setNotice(null);
    setRunResult("idle"); // only the latest action's result is shown
    setRunData(null);
    setSubmitResult("submitting");
    try {
      const r = await api.arena.submit(language, code, requestRound);
      if (!alive.current || participantFinished.current || exitInProgress.current) return;
      if (currentRoundRef.current !== requestRound || r.round !== requestRound) {
        void syncState();
        return;
      }
      setSubmitData(r);
      setSubmitResult(r.result === "accepted" ? "accepted" : r.result === "compile-error" ? "compile-error" : r.result === "expired" ? "expired" : "wrong");
      setErrorLine(r.compile?.line ?? null);
      setState((prev) =>
        prev
          ? {
              ...prev,
              participant: r.participant,
              finished: r.participant.status === "finished",
              round: prev.round && r.result === "accepted" ? { ...prev.round, status: "solved" } : prev.round,
            }
          : prev,
      );
      if (r.result === "expired") void syncState();
    } catch (err) {
      if (alive.current && currentRoundRef.current === requestRound && !participantFinished.current && !exitInProgress.current) handleActionError(err);
    } finally {
      actionInProgress.current = false;
    }
  }

  const runRef = useRef(handleRun);
  const submitRef = useRef(handleSubmit);
  useEffect(() => {
    runRef.current = handleRun;
    submitRef.current = handleSubmit;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void submitRef.current();
      } else if (e.key === "'") {
        e.preventDefault();
        void runRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- distractions -------------------------------------------------------------------------
  const startingDistraction = useRef(false);
  const distractionCooldown = useRef(0);
  const dState = state?.round?.distraction;
  useEffect(() => {
    if (!dState || dState.state !== "pending" || !roundActive || distraction !== null || transition || eventEnded || exitOpen || exiting || state?.finished || selectingRound !== null || selectingQuestion.current) return;
    if (startingDistraction.current || Date.now() < distractionCooldown.current) return;
    if (elapsedSeconds < dState.atSeconds) return;
    startingDistraction.current = true;
    void (async () => {
      try {
        const s = await api.arena.distractionStart(round);
        if (!alive.current || exitInProgress.current || participantFinished.current) return;
        applyState(s);
        if (s.round?.distraction.state === "active") {
          setInterruptState("active");
          setDistraction(s.round.distraction.index);
        }
      } catch (err) {
        distractionCooldown.current = Date.now() + 3000; // "too early" etc.: try again shortly
        if (err instanceof ApiError && err.isNetwork) markOffline();
      } finally {
        startingDistraction.current = false;
      }
    })();
  }, [elapsedSeconds, dState, round, roundActive, distraction, transition, eventEnded, exitOpen, exiting, state?.finished, selectingRound, applyState, markOffline]);

  const resolvingDistraction = useRef(false);

  async function handleDistractionResolved(cleared: boolean, result: DistractionResult | null) {
    if (exitInProgress.current || participantFinished.current || resolvingDistraction.current) return;
    resolvingDistraction.current = true;
    const requestRound = round;
    setDistraction(null);
    setInterruptState(cleared ? "cleared" : "missed");
    setTimeout(() => setInterruptState("standby"), 2000);
    try {
      const r = await api.arena.distractionResolve({
        round: requestRound,
        result: result?.result ?? "timeout",
        timeTaken: Math.round(result?.timeTaken ?? EVENT.distractionSeconds),
        distractionId: result?.distractionId,
        metrics: result?.metrics,
      });
      if (!alive.current || participantFinished.current || exitInProgress.current) return;
      if (currentRoundRef.current !== requestRound) return;
      setState((prev) => (prev ? { ...prev, participant: r.participant } : prev));
      if (!r.cleared) setInterruptState("missed");
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) markOffline();
    } finally {
      resolvingDistraction.current = false;
    }
    void syncState(); // pick up resumed active coding time from the server
  }

  const exitDisabled = selectingRound !== null || exiting || !!transition || eventEnded || !!state?.finished ||
    runResult === "running" || submitResult === "submitting" || submitResult === "accepted";

  const questionsDisabled = exitDisabled || exitOpen || distraction !== null ||
    state?.round?.distraction.state === "active" || connection === "offline";
  const questionNavigationDisabled = questionsDisabled || !roundActive || problem?.round !== round || editorReadyRound !== round;

  async function selectAdjacentQuestion(target: number | null) {
    if (target === null || questionNavigationDisabled || selectingQuestion.current || actionInProgress.current ||
      exitInProgress.current || participantFinished.current || startingDistraction.current || resolvingDistraction.current) return;
    selectingQuestion.current = true;
    setSelectingRound(target);
    setNotice(null);
    try {
      const next = await api.arena.select(target);
      if (!alive.current) return;
      applyState(next);
      markOnline();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.isNetwork) {
        markOffline();
      } else {
        setNotice(err instanceof ApiError ? err.message : "Could not open that question. Please try again.");
        // Another tab may have solved the target, or a scheduled interruption is due.
        void syncState();
      }
    } finally {
      selectingQuestion.current = false;
      if (alive.current) setSelectingRound(null);
    }
  }

  function openQuestions() {
    if (questionsDisabled || selectingQuestion.current || actionInProgress.current || startingDistraction.current || resolvingDistraction.current) return;
    navigate("/questions");
  }

  function openExitDialog() {
    if (exitDisabled || selectingQuestion.current || exitInProgress.current || participantFinished.current) return;
    setExitError(null);
    setExitOpen(true);
  }

  async function confirmExit() {
    if (exitInProgress.current || participantFinished.current) return;
    if (selectingQuestion.current || actionInProgress.current || startingDistraction.current || resolvingDistraction.current) {
      setExitError("Please wait for the current action to finish, then try again.");
      return;
    }
    exitInProgress.current = true;
    setExiting(true);
    setExitError(null);
    try {
      const next = await api.arena.exit();
      if (!alive.current) return;
      applyState(next, true);
      await refreshMe();
      if (!alive.current) return;
      navigate("/complete?exited=1", { replace: true });
    } catch (err) {
      if (!alive.current) return;
      setExitError(err instanceof ApiError && !err.isNetwork
        ? err.message
        : "Could not confirm your exit with the server. Reconnect and try again. Your saved points are preserved.");
      if (err instanceof ApiError && err.isNetwork) markOffline();
      exitInProgress.current = false;
      setExiting(false);
    }
  }

  const locked = distraction !== null;

  // ---- proctoring: report leaving the tab / full screen -------------------------------------
  useEffect(() => {
    if (eventStatus !== "live" || state?.finished) return;
    let awayAt: number | null = null;
    let wasFullscreen = !!document.fullscreenElement;
    const away = () => {
      if (awayAt === null) awayAt = Date.now();
    };
    const back = () => {
      if (awayAt === null) return;
      const seconds = Math.round((Date.now() - awayAt) / 1000);
      awayAt = null;
      if (seconds >= 2) api.reportProctor("TAB_SWITCH", seconds).catch(() => undefined);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? away() : back());
    const onFullscreen = () => {
      if (wasFullscreen && !document.fullscreenElement) api.reportProctor("FULLSCREEN_EXIT").catch(() => undefined);
      wasFullscreen = !!document.fullscreenElement;
    };
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [eventStatus, state?.finished]);

  if (!state) {
    return (
      <div className="crt-grid crt-scanlines fixed inset-0 flex flex-col items-center justify-center bg-bg-canvas text-accent-cyan">
        <div className="border border-accent-cyan/30 bg-bg-base/80 p-6 text-center font-mono shadow-[0_0_20px_rgba(56,225,255,0.15)]">
          <div className="mb-3 flex justify-center">
            <PixelSpinner />
          </div>
          <p className="text-xs uppercase tracking-widest text-text-secondary">LOADING ARENA...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-bg-canvas">
      <ArenaHUD
        round={round}
        score={score}
        interruptState={interruptState}
        clearedCount={distractionCount}
        solvedRounds={solvedRounds}
        expiredRounds={expiredRounds}
        connection={connection}
        problem={problem}
        onExit={openExitDialog}
        exitDisabled={exitDisabled}
        exiting={exiting}
        onQuestions={openQuestions}
        questionsDisabled={questionsDisabled}
      />

      <nav aria-label="Question navigation" aria-busy={selectingRound !== null} className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border-default bg-bg-base px-3 sm:px-6 xl:px-8">
        <Button
          variant="secondary"
          size="sm"
          icon={<ChevronLeft size={16} aria-hidden="true" />}
          aria-label="Previous question"
          title={previousRound === null ? "No previous unsolved question" : `Go to question ${previousRound}`}
          disabled={questionNavigationDisabled || previousRound === null}
          onClick={() => void selectAdjacentQuestion(previousRound)}
        >Previous</Button>
        <span role="status" aria-live="polite" className="min-w-0 text-center font-mono text-[10px] text-text-muted sm:text-xs">
          {selectingRound !== null ? `Opening question ${selectingRound.toString().padStart(2, "0")}…` : "Unsolved questions"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon={<ChevronRight size={16} aria-hidden="true" />}
          aria-label="Next question"
          title={nextRound === null ? "No next unsolved question" : `Go to question ${nextRound}`}
          disabled={questionNavigationDisabled || nextRound === null}
          onClick={() => void selectAdjacentQuestion(nextRound)}
        >Next</Button>
      </nav>

      {connection === "offline" && (
        <div className="flex h-10 items-center justify-center border-b border-danger/40 bg-fill-danger px-4 text-center font-body text-sm text-danger">
          Connection lost. Keep coding — your work is saved on this device. Run and Submit are paused.
        </div>
      )}

      {reconnected && (
        <div className="flex h-10 items-center justify-center border-b border-success/40 bg-fill-success px-4 text-center font-body text-sm text-success">
          ✓ Reconnected. Run and Submit are back.
        </div>
      )}

      {/* Mobile / tablet segmented workspace tabs */}
      <div className="flex h-11 shrink-0 border-b border-border-hairline bg-bg-base lg:hidden">
        {(["PROBLEM", "CODE", "RESULTS"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setMobileTab(t)}
            className={cn(
              "flex-1 font-label text-[16px] uppercase tracking-[0.04em]",
              mobileTab === t ? "bg-bg-elevated text-accent-cyan" : "text-text-muted",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="relative flex flex-1 overflow-hidden">
        <div
          className={cn(
            "w-full flex-col overflow-hidden lg:flex lg:w-[40%] lg:min-w-[380px] lg:max-w-[640px]",
            mobileTab === "PROBLEM" ? "flex" : "hidden",
            locked && "pointer-events-none",
          )}
        >
          <div className={cn("h-full", locked && "blur-[8px] saturate-[0.6]")}>
            <ProblemPanel key={round} problem={problem} round={round} />
          </div>
        </div>

        <div className="hidden w-[1px] bg-border-default lg:block" />

        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden lg:flex",
            mobileTab === "CODE" || mobileTab === "RESULTS" ? "flex" : "hidden",
            locked && "pointer-events-none",
          )}
        >
          <div ref={editorColRef} className={cn("flex min-h-0 flex-1 flex-col", locked && "blur-[8px] saturate-[0.6]")}>
            <div className={cn("min-h-0 flex-1", mobileTab === "RESULTS" && "hidden lg:block")}>
              <CodeEditor
                key={round}
                locked={selectingRound !== null || submitResult === "submitting" || exitOpen || exiting || !!state.finished || problem?.round !== round}
                lockedMessage={selectingRound !== null || problem?.round !== round ? "Opening question…" : undefined}
                errorLine={errorLine}
                focusLine={focusLine}
                problem={problem}
                draftKey={`cad:code:${user?.id ?? "anon"}:${round}`}
                onChange={(code, language) => {
                  if (problem?.round !== round || currentRoundRef.current !== round) return;
                  editorRef.current = { code, language };
                  setEditorReadyRound(round);
                }}
              />
            </div>
            <div
              className={cn(
                "relative h-[240px] shrink-0 lg:h-[var(--result-h)]",
                mobileTab === "RESULTS" && "!h-full lg:!h-[var(--result-h)]",
              )}
              style={{ "--result-h": `${resultCollapsed ? 40 : resultH}px` } as React.CSSProperties}
            >
              {!resultCollapsed && (
                <ResizeHandle
                  containerRef={editorColRef}
                  height={resultH}
                  onChange={setResultH}
                  disabled={locked}
                />
              )}
              <ResultPanel
                runResult={runResult}
                submitResult={submitResult}
                samples={problem?.samples ?? []}
                runData={runData}
                submitData={submitData}
                notice={notice}
                onRun={() => void handleRun()}
                onSubmit={() => void handleSubmit()}
                onCollapseChange={setResultCollapsed}
                onJumpToLine={(line) => {
                  setMobileTab("CODE");
                  setFocusLine({ line, nonce: Date.now() });
                }}
                disabled={selectingRound !== null || connection === "offline" || locked || !!transition || !roundActive || problem?.round !== round || editorReadyRound !== round || exitOpen || exiting || state.finished || eventEnded}
              />
            </div>
          </div>
        </div>

        {locked && <LockOverlay />}
        {distraction !== null && (
          <DistractionModal
            index={distraction}
            onResolved={(cleared, result) => void handleDistractionResolved(cleared, result)}
            onExit={openExitDialog}
            exitDisabled={exitDisabled}
          />
        )}
        {transition && (
          <RoundTransition round={round} variant={transition.variant} isFinal={transition.isFinal} />
        )}
      </div>

      <StatusBar connection={connection === "offline" ? "Offline" : connection === "reconnecting" ? "Reconnecting" : "Connected"} />

      <ExitChallengeDialog
        open={exitOpen}
        exiting={exiting}
        error={exitError}
        onCancel={() => {
          if (!exitInProgress.current) setExitOpen(false);
        }}
        onConfirm={() => void confirmExit()}
      />

      {eventEnded && (
        <div
          className="crt-scanlines fixed inset-0 z-system flex flex-col items-center justify-center bg-black/95 px-4 text-center"
          role="alert"
        >
          <span className="font-display text-3xl text-text-primary sm:text-5xl">EVENT ENDED</span>
          <p className="mt-4 font-body text-text-secondary">
            The admin has ended the event. Your progress is saved.
          </p>
        </div>
      )}
    </div>
  );
}
