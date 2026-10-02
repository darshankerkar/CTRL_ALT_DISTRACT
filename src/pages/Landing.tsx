import { PublicHeader } from "../components/headers/PublicHeader";
import { Footer } from "../components/Footer";
import { Button } from "../components/ui/Button";
import { CrtMonitor } from "../components/CrtMonitor";
import { useEffect, useState } from "react";
import { useEvent } from "../context/EventContext";
import { LeaderboardTable } from "../components/leaderboard/LeaderboardTable";
import { api } from "../lib/api";
import type { EventInfo, LeaderboardEntry } from "../lib/types";

const steps = (EVENT: EventInfo) => [
  {
    n: "01",
    title: "Join the lobby",
    body: "Sign in, read the rulebook, and join. Wait with the other players.",
  },
  {
    n: "02",
    title: `Solve ${EVENT.totalRounds} rounds`,
    body: `One DSA problem per round, with no time limit per question. ${EVENT.languages.map((l) => l.label).join(", ")}.`,
  },
  {
    n: "03",
    title: "Survive the interrupt",
    body: `A distraction can appear at any moment. Your workspace locks. You have ${EVENT.distractionSeconds} seconds.`,
  },
  {
    n: "04",
    title: "Top the board",
    body: "Round points plus distraction bonuses. Final ranking by score, then time.",
  },
];

export default function Landing() {
  const EVENT = useEvent();
  const STEPS = steps(EVENT);
  const [top, setTop] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    api.leaderboard(5).then((r) => setTop(r.entries)).catch(() => setTop([]));
  }, []);
  return (
    <div className="bg-bg-canvas">
      <PublicHeader />

      {/* Hero */}
      <section className="crt-grid crt-scanlines relative overflow-hidden border-b border-border-hairline px-4 pb-16 pt-16 sm:px-8 lg:px-16">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="mb-6 inline-flex items-center gap-2 rounded-xs border border-accent-cyan/30 bg-fill-info px-3 py-1.5">
              <span className="h-1.5 w-1.5 animate-pulse-slow rounded-full bg-accent-cyan" />
              <span className="font-label text-[11px] uppercase tracking-[0.08em] text-accent-cyan">
                Registrations open
              </span>
              <span className="font-body text-xs text-text-muted">
                · {EVENT.eventDate} · {EVENT.eventTime}
              </span>
            </div>

            <h1 className="font-pixel leading-[1.3] text-[32px] text-text-primary sm:text-[44px] lg:text-[56px]">
              CTRL
              <br />
              ALT
              <br />
              <span className="text-accent-yellow">
                ONE
                <span className="animate-blink text-accent-yellow">▌</span>
              </span>
            </h1>

            <p className="mt-6 font-sans text-xl font-semibold text-text-primary">
              {EVENT.totalRounds} problems. No time limit per question. {EVENT.distractionSeconds}-second interruptions.
            </p>

            <p className="mt-4 max-w-[48ch] font-body text-lg leading-relaxed text-text-secondary">
              A live DSA competition by {EVENT.organizerName}. Solve in a real
              code editor while the game tries to break your focus. Clear the
              interruptions for bonus points. Top the high-score board.
            </p>

            <div className="mt-8 flex flex-col gap-3 xs:flex-row">
              <Button to="/login" variant="primary" size="lg" chamfer fullWidth>
                  Enter the arena
                </Button>
              <Button to="/rules" variant="secondary" size="lg" fullWidth>
                  Read the rules
                </Button>
            </div>

            <div className="mt-10 flex divide-x divide-border-default border border-border-default">
              {[
                ["Rounds", "10"],
                ["Time/round", "No limit"],
                ["Interrupt", "00:30"],
              ].map(([label, val]) => (
                <div key={label} className="flex-1 px-4 py-3">
                  <div className="font-label text-[10px] uppercase tracking-wider text-text-muted">
                    {label}
                  </div>
                  <div className="mt-1 font-mono text-lg font-bold text-text-primary">
                    {val}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-7">
            <CrtMonitor className="mx-auto max-w-[640px]" />
          </div>
        </div>
      </section>

      {/* How a run works */}
      <section id="how-it-works" className="px-4 py-16 sm:px-8 sm:py-24 lg:px-16">
        <div className="mx-auto max-w-[1280px]">
          <h2 className="mb-10 font-sans text-3xl font-bold text-text-primary sm:text-[32px]">
            How a run works
          </h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="border border-border-default bg-bg-panel p-6">
                <div className="font-pixel text-base text-accent-yellow">{s.n}</div>
                <h3 className="mt-4 font-sans text-lg font-semibold text-text-primary">
                  {s.title}
                </h3>
                <p className="mt-2 font-body text-sm text-text-secondary">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The Interrupt */}
      <section className="border-y border-border-hairline bg-bg-base px-4 py-16 sm:px-8 sm:py-24 lg:px-16">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="font-sans text-3xl font-bold text-text-primary sm:text-[32px]">
              The interrupt
            </h2>
            <p className="mt-4 max-w-[60ch] font-body text-base leading-relaxed text-text-secondary">
              Mid-problem, the screen blurs and locks. A mini challenge takes
              over with a 30-second clock. Clear it and earn +
              {EVENT.bonusPoints}. Let it expire and you lose nothing but time
              — you're sent straight back to your code.
            </p>
          </div>
          <div className="relative mx-auto w-full max-w-[480px]">
            <div className="relative overflow-hidden border border-border-default bg-bg-panel p-6">
              <div className="pointer-events-none absolute inset-0 blur-[6px]">
                <pre className="p-4 font-mono text-xs text-syn-default">
                  {`class Solution:\n    def solve(self, nums, k):\n        seen = {}\n        for i, n in enumerate(nums):`}
                </pre>
              </div>
              <div className="absolute inset-0 bg-black/60 hazard-stripes" />
              <div className="relative mx-auto w-full max-w-[280px] border-2 border-accent-magenta bg-bg-panel p-4 chamfer" style={{ boxShadow: "0 0 24px rgba(255,62,165,0.4)" }}>
                <div className="mb-3 flex items-center justify-between font-label text-[10px] uppercase tracking-wide">
                  <span className="text-accent-magenta">⚡ Distraction</span>
                  <span className="text-text-secondary">
                    Bonus +{EVENT.bonusPoints}
                  </span>
                </div>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border-4 border-accent-magenta font-mono text-2xl font-extrabold text-accent-magenta">
                  18
                </div>
                <p className="mt-3 text-center font-label text-[10px] uppercase tracking-wide text-text-muted">
                  Seconds remaining
                </p>
              </div>
              <div className="relative mt-4 flex items-center justify-center gap-2 rounded-xs border border-accent-magenta/40 bg-bg-elevated px-3 py-1.5">
                <span className="font-label text-[10px] uppercase tracking-wide text-text-primary">
                  Workspace locked
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Scoring + leaderboard preview */}
      <section className="px-4 py-16 sm:px-8 sm:py-24 lg:px-16">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 lg:grid-cols-2">
          <div>
            <h2 className="font-sans text-3xl font-bold text-text-primary sm:text-[32px]">
              Scoring
            </h2>
            <dl className="mt-6 divide-y divide-border-hairline border-y border-border-hairline">
              {[
                ["Round points", `+${EVENT.dsaPoints} per solved round`],
                ["Distraction bonus", `+${EVENT.bonusPoints} per cleared interrupt`],
                ["Tiebreak", "Lower total time ranks higher"],
              ].map(([dt, dd]) => (
                <div key={dt} className="flex items-center justify-between gap-4 py-4">
                  <dt className="font-body text-sm text-text-secondary">{dt}</dt>
                  <dd className="font-mono text-sm font-semibold text-text-primary">{dd}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3 className="mb-4 font-pixel text-base text-text-primary">High scores</h3>
            <LeaderboardTable rows={top} compact />
            <p className="mt-3 font-body text-xs text-text-muted">
              {top.length === 0 ? "No scores yet. The board fills as players clear rounds." : "Live standings."}
            </p>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="crt-scanlines relative border-y border-border-hairline px-4 py-20 text-center sm:px-8">
        <h2 className="font-pixel text-xl text-text-primary sm:text-2xl">Insert coin?</h2>
        <p className="mx-auto mt-4 max-w-md font-body text-text-secondary">
          Registration is free for {EVENT.collegeName} students.
        </p>
        <div className="mt-8 flex justify-center">
          <Button to="/login" variant="primary" size="lg" chamfer>
              Enter the arena
            </Button>
        </div>
      </section>

      <Footer />
    </div>
  );
}
