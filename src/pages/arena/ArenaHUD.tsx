import { List, Lock, LogOut } from "lucide-react";
import { Logo } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { useEvent } from "../../context/EventContext";
import { useAuth } from "../../context/AuthContext";
import { padScore, cn, difficultyClasses } from "../../lib/utils";

export type InterruptState = "standby" | "active" | "cleared" | "missed";

export function ArenaHUD({
  round,
  score,
  interruptState,
  clearedCount,
  solvedRounds,
  expiredRounds,
  connection = "connected",
  problem,
  onExit,
  exitDisabled,
  exiting,
  onQuestions,
  questionsDisabled,
}: {
  round: number;
  score: number;
  interruptState: InterruptState;
  clearedCount: number;
  solvedRounds: number[];
  expiredRounds: number[];
  connection?: "connected" | "reconnecting" | "offline";
  problem?: { title: string; difficulty: string } | null;
  onExit: () => void;
  exitDisabled: boolean;
  exiting: boolean;
  onQuestions: () => void;
  questionsDisabled: boolean;
}) {
  const EVENT = useEvent();
  const { initials } = useAuth();
  return (
    <header className="relative z-sticky grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-default bg-bg-canvas px-3 sm:h-[80px] sm:gap-4 sm:px-6 xl:px-8">
      <div className="flex min-w-0 items-center gap-4 xl:gap-6">
        {/* Brand */}
        <div className="hidden shrink-0 items-center xl:flex">
          <Logo size={36} wordmark={false} />
        </div>

        {/* Round */}
        <div className="flex shrink-0 flex-col justify-center gap-1 xl:border-l xl:border-border-default xl:pl-6">
          <span className="font-body text-[10px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Round
          </span>
          <span className="font-mono text-base font-bold leading-none text-text-primary font-tnum sm:text-lg">
            {round.toString().padStart(2, "0")}
            <span className="text-text-muted">/{EVENT.totalRounds}</span>
          </span>
          <div className="hidden max-w-28 flex-wrap gap-[3px] sm:flex" aria-hidden="true">
            {Array.from({ length: EVENT.totalRounds }).map((_, i) => {
              const n = i + 1;
              const solved = solvedRounds.includes(n);
              const expired = expiredRounds.includes(n);
              const current = n === round;
              return (
                <span
                  key={n}
                  className={cn(
                    "h-1.5 w-1.5",
                    solved && "bg-success",
                    expired && "bg-danger/60",
                    current && !solved && !expired && "border-2 border-accent-cyan",
                    !solved && !expired && !current && "border border-border-strong",
                  )}
                />
              );
            })}
          </div>
        </div>

        {/* Problem meta */}
        <div className="hidden min-w-0 flex-col items-start justify-center gap-1.5 border-l border-border-default pl-4 lg:flex xl:pl-6">
          {problem && (
            <>
              <span className={cn("shrink-0 rounded-xs px-1.5 py-0.5 font-body text-[10px] font-semibold uppercase tracking-wide", difficultyClasses(problem.difficulty))}>
                ▲ {problem.difficulty}
              </span>
              <span className="w-full truncate font-sans text-sm font-medium text-text-primary" title={problem.title}>{problem.title}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-3 sm:gap-5 xl:gap-6">
        <Button
          variant="secondary"
          size="sm"
          icon={<List size={14} aria-hidden="true" />}
          onClick={onQuestions}
          disabled={questionsDisabled}
          aria-label="All questions"
          className="shrink-0 !px-2 sm:!px-3"
        >
          <span className="sm:hidden">Questions</span>
          <span className="hidden sm:inline">All questions</span>
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon={<LogOut size={14} aria-hidden="true" />}
          onClick={onExit}
          disabled={exitDisabled}
          loading={exiting}
          loadingLabel="Exiting…"
          aria-label="Exit challenge"
          className="shrink-0 !px-2 sm:!px-3"
        >
          <span className="sm:hidden">Exit</span>
          <span className="hidden sm:inline">Exit challenge</span>
        </Button>

        {/* Score */}
        <div className="flex shrink-0 flex-col justify-center gap-1.5">
          <span className="font-body text-[10px] font-medium uppercase leading-none tracking-[0.12em] text-text-muted">
            Score
          </span>
          <div className="font-mono text-base font-bold leading-none text-accent-yellow font-tnum sm:text-xl">
            {padScore(score)}
          </div>
        </div>

        {/* Interrupt */}
        <div className="hidden shrink-0 flex-col justify-center gap-1.5 border-l border-border-default pl-5 md:flex xl:pl-6">
          <span className="font-body text-[10px] font-medium uppercase leading-none tracking-[0.12em] text-text-muted">
            Interrupt
          </span>
          <span
            className={cn(
              "whitespace-nowrap font-mono text-xs font-bold leading-none",
              interruptState === "active" && "animate-pulse-fast text-accent-magenta",
              interruptState === "cleared" && "text-success",
              interruptState === "missed" && "text-text-muted",
              interruptState === "standby" && "text-text-muted",
            )}
          >
            {interruptState === "active" && "⚡ ACTIVE"}
            {interruptState === "cleared" && "✓ CLEARED"}
            {interruptState === "missed" && "✕ MISSED"}
            {interruptState === "standby" && "◌ STANDBY"}
          </span>
          <span className="font-body text-[10px] text-text-muted">Cleared {clearedCount}</span>
        </div>

        {/* Player */}
        <div className="flex shrink-0 items-center gap-2 sm:border-l sm:border-border-default sm:pl-5 xl:pl-6" title={`Connection: ${connection}`}>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connection === "connected" && "bg-success",
              connection === "reconnecting" && "animate-pulse-slow bg-warning",
              connection === "offline" && "bg-danger",
            )}
          />
          <span className="hidden h-8 w-8 items-center justify-center rounded-sm border border-accent-cyan/15 bg-accent-cyan/10 font-mono text-xs font-bold text-accent-cyan sm:flex">
            {initials}
          </span>
          {connection === "offline" && <Lock size={14} className="text-danger" />}
        </div>
      </div>
    </header>
  );
}
