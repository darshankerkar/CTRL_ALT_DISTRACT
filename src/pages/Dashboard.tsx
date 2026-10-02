import { ArcadeSides } from "../components/ArcadeSides";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, CircleAlert, Lock, X } from "lucide-react";
import { AppHeader, type EventBadgeState } from "../components/headers/AppHeader";
import { Button, PixelSpinner } from "../components/ui/Button";
import { api, ApiError } from "../lib/api";
import { cn, formatMMSS, padScore } from "../lib/utils";
import { useEvent, useRefreshEvent } from "../context/EventContext";
import { useMe } from "../context/MeContext";
import { useAuth } from "../context/AuthContext";

type DashState = "not-joined" | "joined" | "waiting" | "live" | "ended" | "finished";

const STATE_META: Record<
  DashState,
  { badge: EventBadgeState; cta: string; helper: string; disabled?: boolean; lock?: boolean }
> = {
  "not-joined": {
    badge: "upcoming",
    cta: "Join event",
    helper: "Joining puts you in the lobby. The admin starts the event for everyone at once.",
  },
  joined: {
    badge: "joined",
    cta: "Go to lobby",
    helper: "You're in. Wait in the lobby for the start.",
  },
  waiting: {
    badge: "waiting",
    cta: "Lobby opens soon",
    helper: "The lobby opens soon.",
    disabled: true,
    lock: true,
  },
  live: {
    badge: "live",
    cta: "Return to arena",
    helper: "Your run is in progress.",
  },
  ended: {
    badge: "ended",
    cta: "View leaderboard",
    helper: "Final results are in.",
  },
  finished: {
    badge: "finished",
    cta: "View leaderboard",
    helper: "Your participation has finished. Your earned points are saved.",
  },
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { firstName } = useAuth();
  const EVENT = useEvent();
  const refreshEvent = useRefreshEvent();
  const { me, refresh: refreshMe } = useMe();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [checklistAttempted, setChecklistAttempted] = useState(false);
  const checklistInputs = useRef<Array<HTMLInputElement | null>>([]);
  const checklistErrorRef = useRef<HTMLDivElement>(null);

  // Always show fresh progress when landing here or when the event changes phase.
  useEffect(() => {
    void refreshMe();
  }, [EVENT.status, refreshMe]);

  const part = me?.participation ?? null;
  const checklistConfirmed = part !== null;
  const state: DashState =
    part?.status === "finished"
      ? "finished"
      : EVENT.status === "ended"
        ? "ended"
        : !part
          ? "not-joined"
          : EVENT.status === "live"
            ? "live"
            : "joined";
  const showScore = part !== null && (state === "finished" || state === "ended");
  const helper =
    state === "live" && part
      ? `Your run is in progress. Round ${Math.max(part.currentRound, 1)}/${EVENT.totalRounds}.`
      : state === "finished" && part
        ? `Your score: ${part.totalPts}`
        : STATE_META[state].helper;

  const meta = STATE_META[state];
  const checklistDone = checks.every(Boolean);
  const gated = state === "not-joined" && !checklistDone;
  const checklistError = checklistAttempted && gated;
  const ctaDisabled = !!meta.disabled;
  const gatedClass = gated ? "bg-white! text-neutral-500! shadow-none! hover:bg-white! hover:shadow-none!" : undefined;

  useEffect(() => {
    if (checklistError) checklistErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [checklistError]);

  const handlePrimary = () => {
    if (gated) {
      setChecklistAttempted(true);
      const firstMissing = checklistInputs.current[checks.findIndex((checked) => !checked)];
      checklistErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      firstMissing?.focus({ preventScroll: true });
      return;
    }
    setChecklistAttempted(false);
    if (state === "not-joined") return setConfirmOpen(true);
    if (state === "joined") return navigate("/lobby");
    if (state === "live") return navigate("/arena");
    if (state === "ended" || state === "finished") return navigate("/leaderboard");
  };

  const confirmJoin = async () => {
    setJoining(true);
    setJoinError("");
    try {
      await api.join();
      await Promise.all([refreshMe(), refreshEvent()]);
      setConfirmOpen(false);
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : "Could not join. Please try again.");
    } finally {
      setJoining(false);
    }
  };

  const playerId = me?.playerCode ?? "—";

  return (
    <div className="min-h-screen bg-bg-canvas isolate">
      <ArcadeSides contentMax={1280} />
      <AppHeader eventState={meta.badge} />

      <main className="mx-auto max-w-[1280px] px-4 py-10 pb-24 sm:px-8 lg:pb-10">
        <h1 className="font-display text-5xl text-text-primary sm:text-6xl">
          Hi, {firstName}.
        </h1>
        <p className="mt-1 font-body text-sm text-text-muted">
          Player ID {playerId} · {EVENT.collegeName}
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Event card */}
          <div className="lg:col-span-8">
            <div className="relative overflow-hidden border border-border-default bg-bg-panel p-6 chamfer-lg sm:p-8">
              <div className="absolute inset-x-0 top-0 h-[2px] bg-accent-yellow" />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-pixel text-base text-text-primary sm:text-lg">
                  CTRL ALT DISTRACT
                </h2>
                <span
                  className={cn(
                    "rounded-xs border px-2.5 py-1 font-label text-[16px] uppercase tracking-[0.04em]",
                    meta.badge === "live" && "border-danger/40 bg-fill-danger text-danger",
                    meta.badge === "waiting" && "border-warning/40 bg-fill-warning text-warning",
                    (meta.badge === "upcoming" || meta.badge === "joined") &&
                      "border-accent-cyan/30 bg-fill-info text-accent-cyan",
                    meta.badge === "ended" && "border-border-default bg-white/5 text-text-muted",
                    meta.badge === "finished" && "border-success/35 bg-fill-success text-success",
                  )}
                >
                  {meta.badge}
                </span>
              </div>

              <div className="mt-6 grid grid-cols-2 divide-x divide-border-default border border-border-default sm:grid-cols-4">
                {[
                  ["Rounds", String(EVENT.totalRounds)],
                  ["Per round", "No time limit"],
                  ["Interrupt", formatMMSS(EVENT.distractionSeconds)],
                  ["Languages", EVENT.languages.map((l) => l.label.toUpperCase()).join(" · ")],
                ].map(([label, val]) => (
                  <div key={label} className="px-4 py-3">
                    <div className="font-label text-[15px] uppercase tracking-[0.04em]r text-text-muted">
                      {label}
                    </div>
                    <div className="mt-1 font-mono text-lg font-bold text-text-primary">
                      {val}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-4">
                <Button
                  variant="primary"
                  size="lg"
                  chamfer
                  disabled={ctaDisabled}
                  aria-disabled={gated || ctaDisabled}
                  aria-describedby={checklistError ? "join-checklist-error" : undefined}
                  className={gatedClass}
                  icon={meta.lock ? <Lock size={18} /> : undefined}
                  onClick={handlePrimary}
                >
                  {meta.cta}
                </Button>
              </div>
              {checklistError ? (
                <div
                  id="join-checklist-error"
                  ref={checklistErrorRef}
                  role="alert"
                  className="mt-4 flex scroll-mb-24 items-start gap-2.5 rounded-sm border border-danger/40 bg-fill-danger px-3 py-3 font-body text-sm text-danger"
                >
                  <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <p>
                    <span className="font-semibold">Complete the checklist before joining.</span>{" "}
                    <span className="hidden lg:inline">Tick all three checkboxes in the “Before you join” panel on the right.</span>
                    <span className="lg:hidden">Tick all three checkboxes in the “Before you join” panel below.</span>
                  </p>
                </div>
              ) : (
                <p className="mt-3 font-body text-sm text-text-muted">
                  {gated ? "Confirm all three checklist items before joining." : helper}
                </p>
              )}
            </div>
          </div>

          {/* Status panel */}
          <div className="lg:col-span-4">
            <div className={cn("border bg-bg-panel p-6", checklistError ? "border-danger/60" : "border-border-default")}>
              <div className="flex flex-col divide-y divide-border-hairline">
                {[
                  ["Entry", part ? "Joined" : "Not joined"],
                  ["Rounds", `${part?.solvedCount ?? 0}/${EVENT.totalRounds}`],
                  ["Score", showScore && part ? padScore(part.totalPts) : "----"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-2.5">
                    <span className="font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">
                      {k}
                    </span>
                    <span className="font-mono text-sm font-bold text-text-primary">{v}</span>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                <h3 className="font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">{checklistConfirmed ? "Checklist confirmed" : "Before you join"}</h3>
                {["I've read the rulebook", "I'm on a desktop or laptop", "My internet connection is stable"].map(
                  (label, i) => (
                    <label key={label} className={cn("flex items-center gap-2.5", checklistConfirmed ? "cursor-default" : "cursor-pointer")}>
                      <input
                        ref={(input) => { checklistInputs.current[i] = input; }}
                        type="checkbox"
                        checked={checklistConfirmed || checks[i]}
                        disabled={checklistConfirmed}
                        aria-invalid={checklistError && !checks[i] ? true : undefined}
                        aria-describedby={checklistError && !checks[i] ? "join-checklist-error" : undefined}
                        onChange={() =>
                          setChecks((c) => c.map((v, idx) => (idx === i ? !v : v)))
                        }
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex h-[18px] w-[18px] shrink-0 items-center justify-center border border-border-strong bg-bg-inset transition-colors peer-checked:border-success peer-checked:bg-success peer-focus-visible:ring-2 peer-focus-visible:ring-accent-cyan peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-panel",
                          checklistError && !checks[i] && "border-danger",
                        )}
                      >
                        <Check size={14} strokeWidth={3} className={cn("text-bg-canvas", checklistConfirmed || checks[i] ? "opacity-100" : "opacity-0")} />
                      </span>
                      <span className="font-body text-sm text-text-secondary">{label}</span>
                    </label>
                  ),
                )}
              </div>
            </div>
          </div>
        </div>

      </main>

      {/* mobile sticky CTA */}
      <div className="fixed inset-x-0 bottom-0 z-sticky flex h-[72px] items-center border-t border-border-hairline bg-bg-base px-4 lg:hidden">
        <Button
          variant="primary"
          size="lg"
          chamfer
          fullWidth
          disabled={ctaDisabled}
          aria-disabled={gated || ctaDisabled}
          aria-describedby={checklistError ? "join-checklist-error" : undefined}
          className={gatedClass}
          onClick={handlePrimary}
        >
          {meta.cta}
        </Button>
      </div>

      {/* Join confirm dialog */}
      {confirmOpen && (
        <div className="fixed inset-0 z-dialog flex items-end justify-center bg-black/72 backdrop-blur-sm sm:items-center">
          <div className="w-full max-w-[440px] border-t-2 border-accent-cyan bg-bg-elevated p-6 sm:border-t-0 sm:border-2">
            <div className="flex items-start justify-between">
              <h3 className="font-sans text-lg font-semibold text-text-primary">
                Join Ctrl Alt Distract?
              </h3>
              <button
                onClick={() => setConfirmOpen(false)}
                className="text-text-muted hover:text-text-primary"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <p className="mt-3 font-body text-sm text-text-secondary">
              You'll enter the lobby and wait for the admin to start. Once the event
              starts, the {EVENT.totalRounds} rounds run back to back.
            </p>
            {joinError && (
              <p className="mt-3 font-body text-sm text-danger" role="alert">
                {joinError}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" chamfer onClick={() => void confirmJoin()} disabled={joining}>
                {joining ? (
                  <span className="flex items-center gap-2">
                    <PixelSpinner /> Joining…
                  </span>
                ) : (
                  "Join"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
