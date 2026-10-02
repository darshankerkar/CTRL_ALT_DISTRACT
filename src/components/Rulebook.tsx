import { useMemo, useState } from "react";
import { useEvent } from "../context/EventContext";
import type { EventInfo } from "../lib/types";
import { cn, formatMMSS } from "../lib/utils";

function buildSections(EVENT: EventInfo) {
  const interruptClock = formatMMSS(EVENT.distractionSeconds);
  const langs = EVENT.languages.map((l) => l.label);
  const langList = langs.length > 1 ? `${langs.slice(0, -1).join(", ")}, or ${langs[langs.length - 1]}` : langs.join("");
  return [
  {
    id: "structure",
    title: "Structure",
    body: `The competition has ${EVENT.totalRounds} questions. Use All Questions in the arena to choose any unsolved question, in any order. Your code drafts and earned points are saved when you switch questions. Solved questions cannot be submitted again.`,
  },
  {
    id: "time-limits",
    title: "No time limit per question",
    body: "There is no time limit per question. A correct submission returns you to All Questions to choose your next question. Switching questions or browsing the list does not pause your recorded participation time. You can continue until the organizers end the competition.",
  },
  {
    id: "languages",
    title: "Languages",
    body: `Write your solution in ${langList}. You can switch languages during a round.`,
  },
  {
    id: "running-submitting",
    title: "Running and submitting",
    body: "RUN tests your code against the sample cases. SUBMIT checks it against the full test set. A correct submission clears the round.",
  },
  {
    id: "distractions",
    title: "Distractions",
    body: `At random moments during a round, a distraction challenge appears. Your workspace blurs and locks. You have exactly ${EVENT.distractionSeconds} seconds to solve it. Your code is kept exactly as you left it.`,
    chip: interruptClock,
  },
  {
    id: "bonus-scoring",
    title: "Bonus scoring",
    body: `Clearing a distraction earns +${EVENT.bonusPoints}. If the ${EVENT.distractionSeconds} seconds run out, you get no bonus and return to your problem.`,
  },
  {
    id: "leaderboard",
    title: "Leaderboard",
    body: "Ranking is by total score (round points + distraction bonus). Ties are broken by lower total time taken.",
  },
  {
    id: "conduct",
    title: "Conduct",
    body: "Play fair. No sharing solutions, no external help, no multiple accounts. Organizers may disqualify participants who violate these rules.",
  },
  {
    id: "before-you-start",
    title: "Before you start",
    body: "Use a desktop or laptop. Keep this tab open and in focus. Don't refresh during a round.",
  },
  ];
}

export function Rulebook({ scrollable = true }: { scrollable?: boolean }) {
  const EVENT = useEvent();
  const SECTIONS = useMemo(() => buildSections(EVENT), [EVENT]);
  const [active, setActive] = useState(SECTIONS[0].id);

  const scrollTo = (id: string) => {
    setActive(id);
    document.getElementById(`rule-${id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div
        id="rulebook-scroll"
        tabIndex={0}
        aria-label="Rulebook"
        className={cn(
          "relative border border-border-default bg-bg-panel lg:col-span-8",
          scrollable && "max-h-[520px] overflow-y-auto",
        )}
      >
        <div className="divide-y divide-border-hairline">
          {SECTIONS.map((s) => (
            <section id={`rule-${s.id}`} key={s.id} className="p-6">
              <h4 className="font-sans text-lg font-semibold text-text-primary">
                {s.title}
              </h4>
              <p className="mt-2 max-w-[72ch] font-body text-[15px] leading-relaxed text-text-secondary">
                {s.body}
                {s.chip && (
                  <span className="ml-2 inline-block rounded-xs bg-bg-elevated px-1.5 py-0.5 font-mono text-[13px] text-accent-yellow">
                    {s.chip}
                  </span>
                )}
              </p>
            </section>
          ))}
        </div>
        {scrollable && (
          <div className="pointer-events-none sticky bottom-0 h-6 bg-gradient-to-t from-bg-panel to-transparent" />
        )}
      </div>
      <div className="lg:col-span-4">
        <div className="sticky top-24 border border-border-default bg-bg-panel p-4">
          <span className="mb-3 block font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">
            Rule index
          </span>
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  className={cn(
                    "w-full border-l-2 px-3 py-2 text-left font-body text-sm transition-colors",
                    active === s.id
                      ? "border-accent-cyan text-text-primary"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
