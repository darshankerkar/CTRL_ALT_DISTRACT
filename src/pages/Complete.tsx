import { ArcadeSides } from "../components/ArcadeSides";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MinimalHeader } from "../components/headers/MinimalHeader";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import type { Results } from "../lib/types";
import { padScore } from "../lib/utils";

export default function Complete() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const endedEarly = params.get("ended") === "1";
  const exitedEarly = params.get("exited") === "1";
  const [result, setResult] = useState<Results | null>(null);
  const [scoreDisplay, setScoreDisplay] = useState(0);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .results()
      .then((r) => alive && setResult(r))
      .catch(() => alive && navigate("/dashboard", { replace: true }));
    return () => {
      alive = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (!result) return;
    const timers = [
      setTimeout(() => setStage(1), 100),
      setTimeout(() => setStage(2), 900),
      setTimeout(() => setStage(3), 2200),
      setTimeout(() => setStage(4), 2600),
    ];
    return () => timers.forEach(clearTimeout);
  }, [result]);

  useEffect(() => {
    if (stage < 2 || !result) return;
    const total = result.total;
    const duration = 1200;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      setScoreDisplay(Math.round(t * total));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, result]);

  if (!result) return null;
  const RESULT = result;
  const completedAllRounds = RESULT.rounds.length > 0 && RESULT.rounds.every(Boolean);

  return (
    <div className="crt-grid min-h-screen bg-bg-canvas">
      <ArcadeSides contentMax={800} />
      <div className="crt-vignette pointer-events-none fixed inset-0 -z-10" aria-hidden="true" />
      <MinimalHeader />
      <main className="mx-auto flex max-w-[800px] flex-col items-center px-4 py-16 text-center sm:py-24">
        <p className="font-mono text-sm text-text-muted">
          {exitedEarly ? "> challenge exited" : endedEarly ? "> event ended by admin" : "> participation finished"}
          <span className="animate-blink">_</span>
        </p>

        <h1
          className="mt-6 font-display text-4xl text-text-primary transition-opacity duration-300 sm:text-6xl"
          style={{ opacity: stage >= 1 ? 1 : 0 }}
        >
          {exitedEarly ? "CHALLENGE EXITED" : endedEarly ? "RUN ENDED" : completedAllRounds ? "TASK COMPLETED" : "PARTICIPATION FINISHED"}
        </h1>
        <p
          className="mt-3 font-sans text-xl text-text-secondary transition-opacity duration-300"
          style={{ opacity: stage >= 1 ? 1 : 0 }}
        >
          {exitedEarly
            ? "Your participation has ended. All earned points are saved on the leaderboard."
            : endedEarly
              ? "The admin ended the event. Your progress is saved."
              : completedAllRounds
                ? RESULT.fullName
                : "Your participation has finished. All earned points are saved on the leaderboard."}
        </p>

        <div className="mt-10">
          <span className="font-label text-lg uppercase tracking-[0.04em] text-text-muted">
            Total score
          </span>
          <div className="relative mt-2 font-mono text-6xl font-extrabold text-accent-yellow font-tnum sm:text-8xl">
            <span className="text-ghost absolute inset-0">8888</span>
            {padScore(scoreDisplay)}
          </div>
        </div>

        <div
          className="mt-10 grid w-full grid-cols-2 gap-4 transition-opacity duration-300 sm:grid-cols-4"
          style={{ opacity: stage >= 3 ? 1 : 0 }}
        >
          {[
            ["Round pts", RESULT.roundPts.toString(), "text-text-primary"],
            ["Bonus", `+${RESULT.bonus}`, "text-accent-magenta"],
            ["Solved", `${RESULT.solved}/${RESULT.rounds.length}`, "text-success"],
            ["Time taken", RESULT.timeTaken, "text-text-primary"],
          ].map(([label, val, color]) => (
            <div key={label} className="border border-border-default bg-bg-panel p-5 chamfer">
              <div className="font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">
                {label}
              </div>
              <div className={`mt-2 font-mono text-2xl font-bold ${color}`}>{val}</div>
            </div>
          ))}
        </div>

        <div
          className="mt-8 transition-opacity duration-300"
          style={{ opacity: stage >= 3 ? 1 : 0 }}
        >
          <div className="flex flex-wrap justify-center gap-2">
            {RESULT.rounds.map((solved, i) => (
              <span
                key={i}
                title={solved ? `Round ${i + 1} — solved` : `Round ${i + 1} — not solved`}
                className={`flex h-6 w-6 items-center justify-center font-mono text-[10px] font-bold ${
                  solved ? "bg-success/20 text-success" : "bg-danger/20 text-danger"
                }`}
              >
                {(i + 1).toString().padStart(2, "0")}
              </span>
            ))}
          </div>
          <p className="mt-3 font-body text-sm text-text-muted">
            Distractions cleared {RESULT.distractionsCleared}/{RESULT.distractionsTotal}
          </p>
        </div>

        <div
          className="mt-12 transition-opacity duration-300"
          style={{ opacity: stage >= 4 ? 1 : 0 }}
        >
          <Button to="/leaderboard" variant="primary" size="lg" chamfer autoFocus>
              View leaderboard
            </Button>
          <p className="mt-4 font-body text-sm text-text-muted">
            Results are final once the admin closes the event.
          </p>
        </div>
      </main>
    </div>
  );
}
