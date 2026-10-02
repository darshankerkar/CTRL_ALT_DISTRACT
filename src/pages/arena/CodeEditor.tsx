import { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Plus, RotateCcw, Keyboard } from "lucide-react";
import { highlightCode } from "../../lib/highlight";
import type { LanguageId, Problem } from "../../lib/types";
import { useEvent } from "../../context/EventContext";
import { cn } from "../../lib/utils";

const LANG_KEY = "cad:lang";

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: drafts just won't survive a refresh */
  }
}

export function CodeEditor({
  locked,
  lockedMessage = "Locked while submitting",
  readOnly,
  errorLine,
  focusLine,
  problem,
  draftKey,
  onChange,
}: {
  locked?: boolean;
  lockedMessage?: string;
  readOnly?: boolean;
  errorLine?: number | null;
  focusLine?: { line: number; nonce: number } | null;
  problem: Problem | null;
  /** Prefix for locally saved drafts (one per player, round and language). */
  draftKey: string;
  onChange?: (code: string, language: LanguageId) => void;
}) {
  const LANGS = useEvent().languages;
  const [lang, setLang] = useState<LanguageId>(() => {
    const saved = readStore(LANG_KEY);
    return (LANGS.find((l) => l.id === saved) ?? LANGS[0]).id;
  });
  const [code, setCode] = useState("");
  const [fontSize, setFontSize] = useState(14);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLDivElement>(null);

  const current = LANGS.find((l) => l.id === lang) ?? LANGS[0];
  const lineCount = code.split("\n").length;

  // Load the saved draft for this language, or the problem's starter template.
  useEffect(() => {
    if (!problem) return;
    const next = readStore(`${draftKey}:${lang}`) ?? problem.starterCode[lang];
    setCode(next);
    onChange?.(next, lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, lang, draftKey]);

  const updateCode = (next: string) => {
    setCode(next);
    writeStore(`${draftKey}:${lang}`, next);
    onChange?.(next, lang);
  };

  useEffect(() => {
    if (!focusLine || !taRef.current) return;
    const lines = code.split("\n");
    const idx = Math.min(focusLine.line, lines.length) - 1;
    const start = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
    taRef.current.focus();
    taRef.current.setSelectionRange(start, start + lines[idx].length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLine?.nonce]);

  const syncScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg-inset">
      {/* Tab bar */}
      <div className="flex h-9 items-center border-b border-border-hairline bg-bg-base">
        <div className="flex h-full items-center gap-2 border-t-2 border-accent-cyan bg-bg-inset px-4 font-mono text-xs text-text-primary">
          {!saved && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
          {current.file}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex h-11 items-center gap-2 border-b border-border-hairline bg-bg-base px-3">
        <div className="relative">
          <button
            onClick={() => setLangMenuOpen((v) => !v)}
            disabled={locked}
            className="flex h-8 w-[140px] items-center justify-between rounded-xs border border-border-default bg-bg-inset px-2.5 font-body text-sm text-text-primary hover:border-border-strong disabled:opacity-50"
          >
            {current.label}
            <ChevronDown size={14} className="text-text-muted" />
          </button>
          {langMenuOpen && (
            <div className="absolute left-0 top-9 z-dropdown w-[140px] border border-border-default bg-bg-elevated py-1 shadow-[0_24px_64px_rgba(0,0,0,0.8)]">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => {
                    setLang(l.id);
                    writeStore(LANG_KEY, l.id);
                    setLangMenuOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left font-body text-sm hover:bg-bg-hover",
                    l.id === lang ? "text-accent-cyan" : "text-text-primary",
                  )}
                >
                  {l.label}
                  {l.id === lang && "✓"}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          title="Reset to template"
          aria-label="Reset to template"
          disabled={locked}
          onClick={() => problem && updateCode(problem.starterCode[lang])}
          className="flex h-8 w-8 items-center justify-center rounded-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={16} />
        </button>
        <button
          title="Decrease font"
          aria-label="Decrease font"
          onClick={() => setFontSize((f) => Math.max(12, f - 1))}
          className="flex h-8 w-8 items-center justify-center rounded-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <Minus size={16} />
        </button>
        <button
          title="Increase font"
          aria-label="Increase font"
          onClick={() => setFontSize((f) => Math.min(18, f + 1))}
          className="flex h-8 w-8 items-center justify-center rounded-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <Plus size={16} />
        </button>
        <button
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
          className="flex h-8 w-8 items-center justify-center rounded-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <Keyboard size={16} />
        </button>

        <span className="ml-auto hidden font-mono text-[11px] text-text-muted sm:inline">
          {saved ? "Saved locally" : "Saving…"}
        </span>
      </div>

      {/* Editor surface */}
      <div className={cn("relative flex-1 overflow-hidden", locked && "pointer-events-none select-none")}>
        <div className="flex h-full">
          <div
            className="select-none border-r border-border-hairline bg-bg-inset px-3 pt-3 text-right font-mono text-text-muted"
            style={{ fontSize, lineHeight: 1.6 }}
          >
            {Array.from({ length: lineCount }).map((_, i) => (
              <div key={i} className={errorLine === i + 1 ? "font-bold text-danger" : undefined}>
                {errorLine === i + 1 ? "●" : i + 1}
              </div>
            ))}
          </div>
          <div className="relative flex-1">
            <div
              ref={preRef}
              className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre px-4 pt-3 font-mono text-syn-default"
              style={{ fontSize, lineHeight: 1.6 }}
              aria-hidden="true"
            >
              {highlightCode(code, lang, errorLine)}
            </div>
            <textarea
              ref={taRef}
              value={code}
              readOnly={readOnly || locked}
              onScroll={syncScroll}
              onChange={(e) => {
                updateCode(e.target.value);
                setSaved(false);
                setTimeout(() => setSaved(true), 800);
              }}
              spellCheck={false}
              aria-label={`Code editor, ${current.label}`}
              className="absolute inset-0 h-full w-full resize-none whitespace-pre bg-transparent px-4 pt-3 font-mono text-transparent caret-accent-yellow outline-none"
              style={{ fontSize, lineHeight: 1.6 }}
            />
          </div>
        </div>
        {locked && (
          <div className="absolute inset-0 flex items-end justify-center border border-dashed border-border-strong pb-2">
            <span className="font-body text-xs text-text-muted">{lockedMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
