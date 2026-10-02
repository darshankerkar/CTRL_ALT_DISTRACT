import { useEvent } from "../../context/EventContext";
import { cn } from "../../lib/utils";

export function RoundTransition({
  round,
  variant,
  isFinal,
}: {
  round: number;
  variant: "clear" | "closed";
  isFinal: boolean;
}) {
  const EVENT = useEvent();
  return (
    <div className="crt-scanlines absolute inset-0 z-transition flex flex-col items-center justify-center bg-black/94" role="status" aria-live="assertive">
      <span className="font-label text-lg uppercase tracking-[0.04em] text-text-muted">
        Round {round.toString().padStart(2, "0")}
      </span>
      <span
        className={cn(
          "mt-3 font-display text-4xl sm:text-6xl",
          variant === "clear" ? "text-success" : "text-danger",
        )}
      >
        {variant === "clear" ? "CLEAR" : "ROUND CLOSED"}
      </span>
      {variant === "clear" ? (
        <span className="mt-3 font-mono text-2xl font-bold text-accent-yellow">
          +{EVENT.dsaPoints}
        </span>
      ) : (
        <span className="mt-3 font-body text-text-secondary">No points for this round.</span>
      )}

      {isFinal ? (
        <span className="mt-8 font-display text-2xl text-accent-yellow">FINAL ROUND COMPLETE</span>
      ) : (
        <span className="mt-8 flex items-center gap-2 font-label text-base uppercase tracking-[0.04em] text-text-secondary">
          Choose your next question
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-pulse-slow bg-accent-cyan"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        </span>
      )}
    </div>
  );
}
