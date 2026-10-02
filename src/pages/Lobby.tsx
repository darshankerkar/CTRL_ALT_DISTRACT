import { ArcadeSides } from "../components/ArcadeSides";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { LobbyHeader } from "../components/headers/LobbyHeader";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";
import type { Lobby as LobbyData } from "../lib/types";
import { cn, formatMMSS } from "../lib/utils";
import { useEvent } from "../context/EventContext";
import { useMe } from "../context/MeContext";
import { useAuth } from "../context/AuthContext";

export default function Lobby() {
  const navigate = useNavigate();
  const EVENT = useEvent();
  const { status } = EVENT;
  const { fullName, initials } = useAuth();
  const { me, loading: meLoading } = useMe();
  const [query, setQuery] = useState("");
  const [countdown, setCountdown] = useState<null | number | "GO">(null);
  const [lobby, setLobby] = useState<LobbyData>({ count: 0, players: [] });
  const [leaving, setLeaving] = useState(false);

  // Roster: refreshed every few seconds while we wait.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .lobby()
        .then((l) => alive && setLobby(l))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Only joined players belong here.
  useEffect(() => {
    if (!meLoading && me && !me.participation) navigate("/dashboard", { replace: true });
  }, [me, meLoading, navigate]);

  const players = useMemo(
    () => lobby.players.filter((p) => p.id !== me?.playerCode),
    [lobby.players, me?.playerCode],
  );
  const filtered = useMemo(
    () => players.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [players, query],
  );

  // The admin starting the event flips status to "live" for everyone: run the 3-2-1, then enter the arena.
  // Arriving after it already started skips the countdown.
  const prevStatus = useRef(status);
  const arrivedLive = useRef(status === "live");
  useEffect(() => {
    if (prevStatus.current !== "live" && status === "live") setCountdown(3);
    prevStatus.current = status;
  }, [status]);
  useEffect(() => {
    if (arrivedLive.current && me?.participation) navigate("/arena", { replace: true });
  }, [me?.participation, navigate]);

  const leaveLobby = async () => {
    setLeaving(true);
    try {
      await api.leave();
      navigate("/dashboard");
    } catch {
      setLeaving(false);
    }
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === "GO") {
      const t = setTimeout(() => navigate("/arena"), 900);
      return () => clearTimeout(t);
    }
    if (countdown === 0) {
      setCountdown("GO");
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (typeof c === "number" ? c - 1 : c)), 1000);
    return () => clearTimeout(t);
  }, [countdown, navigate]);

  return (
    <div className="min-h-screen bg-bg-canvas isolate">
      <ArcadeSides contentMax={1280} />
      <LobbyHeader />

      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-8">
        {/* Status panel */}
        <div className="relative flex flex-col items-start justify-between gap-6 border border-border-default bg-bg-panel p-6 chamfer-lg sm:flex-row sm:items-center sm:p-8">
          <div>
            <span className="flex items-center gap-2 font-label text-lg uppercase tracking-[0.04em] text-warning">
              <span className="inline-block h-2 w-2 animate-pulse-slow rounded-full bg-warning" />
              Waiting for admin
            </span>
            <p className="mt-2 max-w-md font-body text-text-secondary">
              The event starts when the admin launches it. Stay on this screen.
            </p>
            <p className="mt-1 font-body text-xs text-text-muted">
              Scheduled {EVENT.eventTime}
            </p>
            <div className="mt-4 flex gap-1" aria-hidden="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <span
                  key={i}
                  className="h-3 w-3 animate-pulse-slow bg-accent-cyan"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
          <div className="text-left sm:text-right">
            <span className="font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">
              Players in lobby
            </span>
            <div className="relative mt-1 font-mono text-5xl font-extrabold text-accent-yellow font-tnum sm:text-6xl">
              <span className="text-ghost absolute inset-0">8888</span>
              {lobby.count.toString().padStart(3, "0")}
            </div>
          </div>

        </div>

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
          {/* Player list */}
          <div className="lg:col-span-8">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div className="relative w-full max-w-xs">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search players…"
                  className="h-10 w-full rounded-xs border border-border-default bg-bg-inset pl-9 pr-3 font-body text-sm text-text-primary placeholder:text-text-muted focus:border-accent-cyan focus:outline-none"
                />
              </div>
              <span className="whitespace-nowrap font-body text-sm text-text-muted">
                {lobby.count} total
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <div className="flex h-[88px] flex-col items-center justify-center gap-1.5 border-2 border-accent-yellow bg-bg-panel px-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xs bg-accent-cyan/15 font-mono text-[11px] font-bold text-accent-cyan">
                  {initials}
                </span>
                <span className="max-w-full truncate font-body text-xs text-text-primary">
                  {fullName}
                </span>
                <span className="rounded-xs border border-accent-yellow px-1 font-label text-[11px] text-accent-yellow">
                  YOU
                </span>
              </div>
              {filtered.map((p) => (
                <div
                  key={p.id}
                  className="flex h-[88px] flex-col items-center justify-center gap-1.5 border border-border-default bg-bg-panel px-2 hover:bg-bg-hover"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-xs bg-bg-elevated font-mono text-[11px] font-bold text-text-secondary">
                    {p.id}
                  </span>
                  <span className="max-w-full truncate font-body text-xs text-text-secondary">
                    {p.name}
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                </div>
              ))}
              {filtered.length === 0 && query && (
                <p className="col-span-full font-body text-sm text-text-muted">
                  No players match "{query}".
                </p>
              )}
            </div>
          </div>

          {/* Quick rules */}
          <div className="lg:col-span-4">
            <div className="border border-border-default bg-bg-panel p-5">
              <span className="mb-3 block font-label text-[16px] uppercase tracking-[0.04em] text-text-muted">
                Quick rules
              </span>
              <div className="flex flex-col divide-y divide-border-hairline">
                {[
                  ["Rounds", `${EVENT.totalRounds} · No time limit per question`],
                  ["Distractions", formatMMSS(EVENT.distractionSeconds)],
                  ["Clear", `+${EVENT.bonusPoints}`],
                  ["Timeout", "No bonus"],
                  ["Langs", EVENT.languages.map((l) => l.label.toUpperCase()).join(" ")],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-2.5">
                    <span className="font-label text-[15px] uppercase tracking-[0.04em] text-text-muted">
                      {k}
                    </span>
                    <span className="font-mono text-sm font-bold text-text-primary">{v}</span>
                  </div>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="mt-4" fullWidth onClick={() => void leaveLobby()} disabled={leaving}>
                Leave lobby
              </Button>
            </div>
          </div>
        </div>
      </main>

      {/* Countdown overlay */}
      {countdown !== null && (
        <div
          className="crt-vignette crt-scanlines fixed inset-0 z-transition flex flex-col items-center justify-center bg-black/92"
          role="status"
          aria-live="assertive"
        >
          <div
            className={cn(
              "font-display select-none",
              countdown === "GO" ? "text-accent-yellow" : "text-text-primary",
            )}
            style={{
              fontSize: "min(42vw, 280px)",
              lineHeight: 1,
              textShadow: "6px 6px 0 #FFD23F55",
            }}
          >
            {countdown}
          </div>
          {countdown !== "GO" && (
            <p className="mt-6 font-label text-lg uppercase tracking-[0.04em] text-text-secondary">
              Round 01 starts in
            </p>
          )}
        </div>
      )}
    </div>
  );
}
