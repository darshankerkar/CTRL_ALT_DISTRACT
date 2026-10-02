import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Play } from "lucide-react";
import { Button, PixelSpinner } from "../../components/ui/Button";
import type { CompileInfo, RunResponse, SampleCase, SubmitResponse } from "../../lib/types";
import { cn, valueClass } from "../../lib/utils";

export type RunResult = "idle" | "running" | "passed" | "failed" | "compile-error";
export type SubmitResult = "idle" | "submitting" | "accepted" | "wrong" | "compile-error" | "expired";

function CompileBlock({
  info,
  onJumpToLine,
}: {
  info: CompileInfo;
  onJumpToLine?: (line: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="border border-danger/40 bg-fill-danger px-3 py-2 text-danger" role="alert">
        ✕ Compilation error
      </div>
      <pre className="mt-2 whitespace-pre-wrap text-danger">
        {info.file},{" "}
        {info.line !== null ? (
          <button
            onClick={() => onJumpToLine?.(info.line!)}
            className="text-accent-cyan underline underline-offset-2 hover:text-text-primary"
          >
            line {info.line}
          </button>
        ) : (
          "unknown line"
        )}
        {`\n${info.message}`}
      </pre>
    </div>
  );
}

export function ResultPanel({
  runResult,
  submitResult,
  samples,
  runData,
  submitData,
  notice,
  onRun,
  onSubmit,
  onJumpToLine,
  onCollapseChange,
  disabled,
}: {
  runResult: RunResult;
  submitResult: SubmitResult;
  samples: SampleCase[];
  runData: RunResponse | null;
  submitData: SubmitResponse | null;
  /** A transport / judge problem to show in the Output tab (busy judge, rate limit, ...). */
  notice: string | null;
  onRun: () => void;
  onSubmit: () => void;
  onJumpToLine?: (line: number) => void;
  onCollapseChange?: (collapsed: boolean) => void;
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    onCollapseChange?.(collapsed);
  }, [collapsed, onCollapseChange]);
  const [tab, setTab] = useState<"TESTCASES" | "OUTPUT">("TESTCASES");
  const [selectedCase, setSelectedCase] = useState(0);

  const failedIndexes = useMemo(
    () => (runData ? runData.cases.filter((c) => c.status !== "pass" && c.status !== "not_run").map((c) => c.index) : []),
    [runData],
  );

  // Panel auto-expands and jumps to the tab that shows the latest result.
  useEffect(() => {
    if (runResult === "idle") return;
    setCollapsed(false);
    if (runResult === "running" || runResult === "compile-error") setTab("OUTPUT");
    else setTab("TESTCASES");
    if (runResult === "failed" && failedIndexes.length > 0) setSelectedCase(failedIndexes[0]);
  }, [runResult, failedIndexes]);

  useEffect(() => {
    if (submitResult === "idle") return;
    setCollapsed(false);
    setTab("OUTPUT");
  }, [submitResult]);

  useEffect(() => {
    if (notice) {
      setCollapsed(false);
      setTab("OUTPUT");
    }
  }, [notice]);

  const caseStatus = (i: number): "neutral" | "pass" | "fail" => {
    const c = runData?.cases[i];
    if (!c || (runResult !== "passed" && runResult !== "failed")) return "neutral";
    if (c.status === "pass") return "pass";
    return c.status === "not_run" ? "neutral" : "fail";
  };

  const current = samples[selectedCase] ?? { input: "", expected: "" };
  const currentRun = runData?.cases[selectedCase];
  const showActual = runResult === "passed" || runResult === "failed";
  const isFail = caseStatus(selectedCase) === "fail";
  const yourOutput = currentRun?.actual ?? currentRun?.message ?? "—";

  return (
    <div className="flex h-full flex-col border-t border-border-default bg-bg-panel">
      <div className="flex h-10 shrink-0 items-center border-b border-border-hairline">
        <div className="flex h-full">
          {(["TESTCASES", "OUTPUT"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setCollapsed(false);
              }}
              className={cn(
                "h-full border-b-2 px-4 font-label text-[16px] uppercase tracking-[0.04em]",
                tab === t
                  ? "border-accent-cyan text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-secondary",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="ml-1 flex h-6 w-6 items-center justify-center text-text-muted hover:text-text-primary"
          aria-label={collapsed ? "Expand result panel" : "Collapse result panel"}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        <div className="ml-auto flex items-center gap-1.5 px-2 sm:gap-2 sm:px-3">
          <Button
            variant="secondary"
            size="sm"
            icon={<Play size={14} />}
            onClick={onRun}
            disabled={disabled || runResult === "running" || submitResult === "submitting"}
            loading={runResult === "running"}
            loadingLabel="RUNNING…"
            trailing="Ctrl+'"
            className="!px-2.5 sm:!px-3 [&_span:last-child]:hidden sm:[&_span:last-child]:inline"
          >
            Run
          </Button>
          <Button
            variant="primary"
            size="sm"
            chamfer={false}
            onClick={onSubmit}
            disabled={disabled || submitResult === "submitting" || runResult === "running"}
            loading={submitResult === "submitting"}
            loadingLabel="SUBMITTING…"
            trailing="Ctrl+Enter"
            className="!px-2.5 sm:!px-3 [&_span:last-child]:hidden sm:[&_span:last-child]:inline"
          >
            Submit
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "TESTCASES" && (
            <div>
              <div className="mb-3 flex gap-2">
                {samples.map((_, i) => {
                  const status = caseStatus(i);
                  return (
                    <button
                      key={i}
                      onClick={() => setSelectedCase(i)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-xs border px-3 py-1.5 font-body text-xs",
                        selectedCase === i
                          ? "border-accent-cyan text-text-primary"
                          : "border-border-default text-text-secondary",
                      )}
                    >
                      <span
                        className={cn(
                          status === "pass" && "text-success",
                          status === "fail" && "text-danger",
                          status === "neutral" && "text-text-muted",
                        )}
                      >
                        {status === "pass" ? "✓" : status === "fail" ? "✕" : "○"}
                      </span>
                      Case {i + 1}
                    </button>
                  );
                })}
              </div>

              {runResult === "passed" && (
                <div className="mb-3 border border-success/35 bg-fill-success px-3 py-2 font-body text-sm text-success" role="status">
                  ✓ All sample cases passed. Submit to check the full test set.
                </div>
              )}
              {runResult === "failed" && runData && (
                <div className="mb-3 border border-danger/40 bg-fill-danger px-3 py-2 font-body text-sm text-danger" role="alert">
                  ✕ {runData.passed}/{runData.total} sample cases passed.
                </div>
              )}

              <div className="border border-border-default bg-bg-inset p-3 font-mono text-[13px]">
                <div className="mb-3">
                  <span className="text-text-muted">Input: </span>
                  <span className={cn("text-text-primary", valueClass(current.input))}>{current.input}</span>
                </div>
                {showActual && isFail ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="border border-success/35 bg-fill-success p-2">
                      <div className="mb-1 font-label text-[15px] uppercase tracking-[0.04em] text-success">
                        Expected
                      </div>
                      <span className={cn("text-text-primary", valueClass(current.expected))}>{current.expected}</span>
                    </div>
                    <div className="border border-danger/40 bg-fill-danger p-2">
                      <div className="mb-1 font-label text-[15px] uppercase tracking-[0.04em] text-danger">
                        Your output
                      </div>
                      <span className={cn("text-text-primary", valueClass(yourOutput))}>{yourOutput}</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-2">
                      <span className="text-text-muted">Expected: </span>
                      <span className={cn("text-text-primary", valueClass(current.expected))}>{current.expected}</span>
                    </div>
                    {showActual && (
                      <div>
                        <span className="text-text-muted">Your output: </span>
                        <span className={cn("text-success", valueClass(currentRun?.actual))}>{currentRun?.actual ?? "—"}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              {runResult === "idle" && (
                <p className="mt-3 font-body text-xs text-text-muted">Run your code to see results.</p>
              )}
            </div>
          )}

          {tab === "OUTPUT" && (
            <div className="font-mono text-[13px] text-text-secondary">
              {runResult === "idle" && submitResult === "idle" && !notice && (
                <p className="text-text-muted">No output yet. Run or submit your code.</p>
              )}
              {notice && runResult === "idle" && submitResult === "idle" && (
                <div className="border border-danger/40 bg-fill-danger px-3 py-2 text-danger" role="alert">
                  {notice}
                </div>
              )}
              {runResult === "running" && (
                <p className="flex items-center gap-2 text-text-primary">
                  <PixelSpinner /> ▶ Running on sample cases…
                </p>
              )}
              {runResult === "compile-error" && runData?.compile && (
                <CompileBlock info={runData.compile} onJumpToLine={onJumpToLine} />
              )}
              {runResult === "passed" && runData && (
                <p className="mb-3 text-success">✓ Ran {runData.total} sample cases — all passed.</p>
              )}
              {runResult === "failed" && runData && (
                <p className="mb-3 text-danger">
                  ✕ Ran {runData.total} sample cases — {failedIndexes.length} failed (
                  {failedIndexes.map((i) => `Case ${i + 1}`).join(", ")}).
                </p>
              )}
              {submitResult === "submitting" && (
                <p className="text-text-primary">⇪ Submitting to full test set…</p>
              )}
              {submitResult === "accepted" && submitData && (
                <div className="border border-success/35 bg-fill-success px-3 py-2 text-success" role="status">
                  ✓ ACCEPTED — {submitData.passed}/{submitData.total} tests
                </div>
              )}
              {submitResult === "wrong" && submitData && (
                <div className="border border-danger/40 bg-fill-danger px-3 py-2 text-danger" role="alert">
                  ✕ {submitData.headline} — {submitData.passed}/{submitData.total} tests passed
                </div>
              )}
              {submitResult === "compile-error" && submitData?.compile && (
                <CompileBlock info={submitData.compile} onJumpToLine={onJumpToLine} />
              )}
              {submitResult === "expired" && (
                <div className="border border-danger/40 bg-fill-danger px-3 py-2 text-danger" role="alert">
                  ✕ ROUND CLOSED
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
