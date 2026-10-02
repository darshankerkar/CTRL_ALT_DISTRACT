import { useEffect, useState } from "react";
import { KeycapStand } from "./Logo";
import { padScore } from "../lib/utils";

const CODE_LINES = [
  "class Solution:",
  "    def solve(self, nums, k):",
  "        seen = {}",
  "        for i, n in enumerate(nums):",
  "            need = k - n",
  "            if need in seen:",
  "                return [seen[need], i]",
  "            seen[n] = i",
];

type Phase = "typing" | "distraction" | "cleared";

export function CrtMonitor({ className = "" }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>("typing");
  const [charCount, setCharCount] = useState(0);
  const [score, setScore] = useState(420);
  const [ring, setRing] = useState(30);
  const [reduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const fullText = CODE_LINES.join("\n");

  useEffect(() => {
    if (reduced) {
      setPhase("distraction");
      setCharCount(fullText.length);
      setRing(27);
      return;
    }
    let raf: number;
    let start = performance.now();
    const LOOP = 12000;

    function tick(now: number) {
      const t = (now - start) % LOOP;

      if (t < 6000) {
        setPhase("typing");
        setCharCount(Math.floor((t / 6000) * fullText.length));
      } else if (t < 9000) {
        setPhase("distraction");
        setCharCount(fullText.length);
        setRing(Math.max(27 - Math.floor((t - 6000) / 100), 20));
      } else {
        setPhase("cleared");
        setCharCount(fullText.length);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, fullText.length]);

  useEffect(() => {
    if (phase === "cleared") {
      const id = setTimeout(() => setScore((s) => s + 50), 300);
      return () => clearTimeout(id);
    }
    if (phase === "typing") setScore(420);
  }, [phase]);

  return (
    <div className={className}>
      <div
        className="relative rounded-sm border border-border-strong bg-bg-elevated p-5 chamfer-lg"
        style={{ boxShadow: "0 24px 64px rgba(0,0,0,0.6)" }}
      >
        <div
          className="relative aspect-[640/460] w-full overflow-hidden bg-bg-inset"
          style={{ boxShadow: "inset 0 0 60px rgba(0,0,0,0.9)" }}
          aria-hidden="true"
        >
          <div className="crt-vignette absolute inset-0 z-20" />
          <div className="crt-scanlines absolute inset-0 z-20" />
          <div className="noise-bg absolute inset-0 z-20" />

          <div className="relative z-10 flex h-full flex-col p-4 font-mono">
            <div className="mb-3 flex items-center justify-between border-b border-border-hairline pb-2">
              <span className="font-label text-[10px] tracking-wider text-text-muted">
                ROUND 04/10
              </span>
              <span className="font-tnum text-lg font-bold text-accent-yellow">
                {padScore(score)}
              </span>
            </div>

            <div
              className="flex-1 text-[13px] leading-[1.6] text-syn-default transition-[filter] duration-300"
              style={{ filter: phase === "distraction" ? "blur(3px)" : "none" }}
            >
              <pre className="whitespace-pre-wrap">
                <span className="text-syn-keyword">class</span>{" "}
                <span className="text-syn-type">Solution</span>:{"\n"}
                {"    "}
                <span className="text-syn-keyword">def</span>{" "}
                <span className="text-syn-function">solve</span>(self, nums, k):
                {"\n"}
                {fullText.slice(CODE_LINES[0].length + CODE_LINES[1].length + 2, charCount)}
                <span className="animate-blink">▌</span>
              </pre>
            </div>

            {phase !== "typing" && (
              <div className="absolute inset-x-6 bottom-6 z-30 border-2 border-accent-magenta bg-bg-panel/95 p-3 chamfer">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-label text-[10px] tracking-wide text-accent-magenta">
                    ⚡ DISTRACTION
                  </span>
                  {phase === "cleared" && (
                    <span className="font-label text-[10px] text-success">
                      ✓ CLEARED +50
                    </span>
                  )}
                </div>
                {phase === "distraction" && (
                  <>
                    <div className="mb-1.5 font-tnum text-xl font-extrabold text-accent-magenta">
                      {ring.toString().padStart(2, "0")}
                    </div>
                    <div className="h-1.5 w-full bg-bg-inset">
                      <div
                        className="h-full bg-accent-magenta transition-all"
                        style={{ width: `${(ring / 30) * 100}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-center">
        <KeycapStand size={44} />
      </div>
      <span className="sr-only">
        Illustration: a coding screen being interrupted by a 30-second distraction challenge.
      </span>
    </div>
  );
}
