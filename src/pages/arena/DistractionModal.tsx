import { useEffect, useState } from "react";
import { useEvent } from "../../context/EventContext";
import { DISTRACTIONS } from "../../utils/distractionRegistry";
import { DistractionIntro } from "../../components/distractions/DistractionIntro";
import { DistractionTimer } from "../../components/distractions/DistractionTimer";
import { DistractionResultView } from "../../components/distractions/DistractionResult";
import { GameFactory } from "../../components/games/GameFactory";
import { Button } from "../../components/ui/Button";
import type {
  DistractionResult as DistractionResultType,
  DistractionSuccessPayload,
  DistractionFailurePayload,
  DistractionTimeoutPayload,
} from "../../types/distraction";

type ModalPhase = "intro" | "playing" | "result";

export function DistractionModal({
  index,
  onResolved,
  onExit,
  exitDisabled,
}: {
  index: number;
  onResolved: (cleared: boolean, result: DistractionResultType | null) => void;
  onExit: () => void;
  exitDisabled: boolean;
}) {
  const EVENT = useEvent();
  const meta = DISTRACTIONS[(index - 1) % DISTRACTIONS.length] || DISTRACTIONS[0];
  const timeLimit = meta.estimatedSeconds ? Math.max(meta.estimatedSeconds + 5, 20) : EVENT.distractionSeconds;

  const [phase, setPhase] = useState<ModalPhase>("intro");
  const [timeRemaining, setTimeRemaining] = useState(timeLimit);
  const [resultPayload, setResultPayload] = useState<DistractionResultType | null>(null);

  // Countdown complete -> Start Game & Timer
  const handleCountdownComplete = () => {
    setPhase("playing");
  };

  useEffect(() => {
    if (phase !== "playing") return;
    const timer = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleGameTimeout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [phase]);

  const handleGameTimeout = () => {
    const payload: DistractionTimeoutPayload = {
      distractionId: meta.id,
      result: "timeout",
      timeTaken: timeLimit,
      timeTakenSeconds: timeLimit,
      timestamp: new Date().toISOString(),
      problemId: index,
    };
    setResultPayload(payload);
    setPhase("result");
  };

  const handleGamePass = (metrics?: Record<string, string | number | boolean>) => {
    const elapsed = Math.max(1, timeLimit - timeRemaining);
    const payload: DistractionSuccessPayload = {
      distractionId: meta.id,
      result: "passed",
      timeTaken: elapsed,
      timeTakenSeconds: elapsed,
      metrics,
      timestamp: new Date().toISOString(),
      problemId: index,
    };
    setResultPayload(payload);
    setPhase("result");
  };

  const handleGameFail = (reason?: string, metrics?: Record<string, string | number | boolean>) => {
    const elapsed = Math.max(1, timeLimit - timeRemaining);
    const payload: DistractionFailurePayload = {
      distractionId: meta.id,
      result: "failed",
      timeTaken: elapsed,
      timeTakenSeconds: elapsed,
      metrics: { ...metrics, reason: reason || "Challenge failed" },
      timestamp: new Date().toISOString(),
      problemId: index,
    };
    setResultPayload(payload);
    setPhase("result");
  };

  const resetChallenge = () => {
    setTimeRemaining(timeLimit);
    setResultPayload(null);
    setPhase("intro");
  };

  const handleFinish = () => {
    const isSuccess = resultPayload?.result === "passed";
    onResolved(isSuccess, resultPayload);
  };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" />

      {/* Main Modal Box */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="distraction-title"
        className="crt-scanlines relative z-20 w-full max-w-2xl overflow-hidden border-2 border-accent-magenta bg-bg-panel chamfer-lg shadow-[0_0_35px_rgba(255,62,165,0.4)] flex flex-col"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-accent-magenta/50 bg-fill-bonus px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span id="distraction-title" className="font-label text-sm sm:text-base uppercase tracking-wide text-accent-magenta">
              ⚡ Distraction #{String(meta.index).padStart(2, "0")} — {meta.title}
            </span>
          </div>

          <div className="flex max-w-full flex-wrap items-center justify-end gap-3 sm:gap-4">
            {phase === "playing" && (
              <DistractionTimer
                totalSeconds={timeLimit}
                timeRemaining={timeRemaining}
                isPaused={false}
              />
            )}
            <span className="flex items-center gap-1 font-mono text-sm sm:text-base font-bold text-accent-magenta">
              +{EVENT.bonusPoints} BONUS 🪙
            </span>
            <Button variant="danger" size="sm" onClick={onExit} disabled={exitDisabled}>
              Exit challenge
            </Button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 flex-1 flex flex-col items-center justify-center min-h-[360px]">
          {phase === "intro" && (
            <DistractionIntro
              meta={meta}
              onCountdownComplete={handleCountdownComplete}
              timeLimit={timeLimit}
            />
          )}

          {phase === "playing" && (
            <div className="w-full flex flex-col items-center">
              <GameFactory
                distractionId={meta.id}
                onPass={handleGamePass}
                onFail={handleGameFail}
                timeRemaining={timeRemaining}
                isPaused={false}
              />
            </div>
          )}

          {phase === "result" && resultPayload && (
            <DistractionResultView
              meta={meta}
              result={resultPayload}
              onContinue={handleFinish}
              onRetry={resetChallenge}
              continueButtonText="RETURN TO CODE"
              hasNextChallenge={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
