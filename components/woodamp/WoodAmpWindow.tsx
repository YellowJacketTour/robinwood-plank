"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { formatTime, useWoodAmp } from "./WoodAmpProvider";

/**
 * The WoodAmp popout — a Winamp-inspired player drawn entirely in the
 * RobinWood system (DESIGN.md):
 *
 * - Cabinet chrome is `.site-footer-surface` — the sanctioned quiet wood
 *   texture. No new grain recipe, no new colors.
 * - The time/track display and the Planklist sit on untextured
 *   bg-panel-strong: grain never goes behind dense data text.
 * - Uncial Antiqua (font-display) only for "WoodAmp" and "Planklist";
 *   Nunito Sans everywhere else; times are tabular numerals.
 * - `data-market-shell` opts the window out of the global marketing type
 *   clamps (it floats over marketing pages too).
 *
 * Desktop (lg+): floating draggable window, bottom-right by default.
 * Mobile: bottom sheet with backdrop — the market filter-sheet pattern
 * (backdrop tap, Escape, focus return, scroll containment).
 */
export default function WoodAmpWindow() {
  const {
    open,
    closeWindow,
    track,
    playlist,
    index,
    playing,
    muted,
    volume,
    shuffle,
    repeat,
    currentTime,
    duration,
    togglePlay,
    next,
    prev,
    selectTrack,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    toggleRepeat,
  } = useWoodAmp();

  const rootRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [showPlaylist, setShowPlaylist] = useState(true);

  const live = playing && !muted;

  // Focus close on open; return focus to the opener on close (Nav's mobile
  // menu does the same dance).
  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() =>
      closeButtonRef.current?.focus()
    );
    return () => {
      window.cancelAnimationFrame(frame);
      openerRef.current?.focus();
    };
  }, [open]);

  // Escape closes, everywhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeWindow();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeWindow, open]);

  // Below lg the sheet contains background scrolling, like the mobile menu.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => {
      document.body.style.overflow = mq.matches ? "" : "hidden";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.style.overflow = "";
    };
  }, [open]);

  // --- desktop drag (title bar) ------------------------------------------
  const onDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const x = Math.max(
      8,
      Math.min(e.clientX - drag.dx, window.innerWidth - rect.width - 8)
    );
    const y = Math.max(
      8,
      Math.min(e.clientY - drag.dy, window.innerHeight - 64)
    );
    setPos({ x, y });
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  if (!open) return null;

  const desktopStyle = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : undefined;

  return (
    <>
      {/* Mobile-only backdrop */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={closeWindow}
        className="fixed inset-0 z-[65] cursor-default bg-black/65 backdrop-blur-[2px] lg:hidden"
      />
      <div
        ref={rootRef}
        data-market-shell
        role="dialog"
        aria-label="WoodAmp music player"
        style={desktopStyle}
        className="site-footer-surface fixed inset-x-0 bottom-0 z-[70] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-t-2xl border border-b-0 border-gold-500/50 pb-[env(safe-area-inset-bottom)] shadow-[0_-18px_50px_rgba(0,0,0,0.8)] lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-[356px] lg:rounded-xl lg:border-b lg:pb-0 lg:shadow-[0_24px_60px_-18px_rgba(0,0,0,0.85),0_4px_16px_rgba(0,0,0,0.5)]"
      >
        <div className="p-2.5">
          {/* grab handle, sheet only */}
          <div
            aria-hidden="true"
            className="mx-auto mb-1 h-1.5 w-11 rounded-full bg-gold-500/35 lg:hidden"
          />

          {/* title bar */}
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            className="flex touch-none select-none items-center gap-2 px-0.5 pb-2 lg:cursor-grab"
          >
            <Image
              src="/images/plank-logo.webp"
              alt=""
              width={17}
              height={24}
              className="h-6 w-auto drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
            />
            <span className="flex-1 font-display text-base leading-none text-gold-300 [text-shadow:0_2px_4px_rgba(0,0,0,0.7)]">
              WoodAmp{" "}
              <span className="ml-1 align-middle font-sans text-[0.5625rem] font-black uppercase tracking-[0.16em] text-gold-600">
                Community Radio
              </span>
            </span>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeWindow}
              aria-label="Close WoodAmp"
              title="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gold-500/25 bg-gradient-to-b from-wood-800 to-wood-950 text-xs text-cream-muted shadow-[inset_0_1px_0_rgba(233,180,63,0.12),0_1px_2px_rgba(0,0,0,0.5)] hover:border-gold-500/50 hover:text-gold-300"
            >
              ✕
            </button>
          </div>

          {/* display — untextured panel-strong, per DESIGN.md */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3.5 gap-y-1 rounded-lg border border-gold-500/25 bg-panel-strong px-3 py-2.5">
            <div className="text-[1.7rem] font-black leading-none tracking-[0.02em] text-gold-300 tabular-nums">
              {formatTime(currentTime)}
            </div>
            <div
              aria-hidden="true"
              className="row-span-2 flex h-[30px] items-end gap-[3px] justify-self-end"
            >
              {[40, 75, 55, 95, 65, 80, 45, 70].map((h, i) => (
                <i
                  key={i}
                  className={`woodamp-eq-bar w-[5px] rounded-[1px] bg-gradient-to-b from-gold-300 to-gold-600 ${
                    live ? "" : "woodamp-eq-paused"
                  }`}
                  style={{ height: `${h}%`, animationDelay: `${i * 0.11}s` }}
                />
              ))}
            </div>
            <div className="woodamp-marquee overflow-hidden whitespace-nowrap text-[0.78rem] text-foreground">
              <span className={live ? "" : "woodamp-marquee-paused"}>
                {index + 1}. {track.title} — {track.artist}&nbsp;&nbsp;***&nbsp;&nbsp;
                {index + 1}. {track.title} — {track.artist}&nbsp;&nbsp;***&nbsp;&nbsp;
              </span>
            </div>
            <div className="col-span-2 flex items-center gap-2 text-[0.5625rem] font-black uppercase tracking-[0.12em] text-cream-muted">
              <span>
                {track.source === "hosted" ? "Hosted" : "Community link"}
              </span>
              <span className="ml-auto tabular-nums">
                {duration > 0 ? formatTime(duration) : "–:––"}
              </span>
            </div>
          </div>

          {/* seek */}
          <div className="px-0.5 pt-2.5">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              disabled={!duration}
              aria-label="Seek"
              className="woodamp-range w-full"
            />
          </div>

          {/* transport */}
          <div className="flex items-center gap-2 px-0.5 pt-2">
            <button
              type="button"
              onClick={prev}
              aria-label="Previous track"
              title="Previous"
              className="flex h-11 min-w-11 items-center justify-center rounded-lg border border-gold-500/25 bg-gradient-to-b from-wood-800 to-wood-950 text-sm text-gold-300 shadow-[inset_0_1px_0_rgba(233,180,63,0.14),0_2px_4px_rgba(0,0,0,0.5)] hover:border-gold-500/50"
            >
              ⏮
            </button>
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              title={playing ? "Pause" : "Play"}
              className="flex h-11 min-w-[52px] items-center justify-center rounded-lg border border-wood-950/60 bg-gradient-to-b from-gold-400 to-gold-600 text-base text-wood-950 shadow-[0_3px_8px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,242,207,0.5)] hover:from-gold-300"
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next track"
              title="Next"
              className="flex h-11 min-w-11 items-center justify-center rounded-lg border border-gold-500/25 bg-gradient-to-b from-wood-800 to-wood-950 text-sm text-gold-300 shadow-[inset_0_1px_0_rgba(233,180,63,0.14),0_2px_4px_rgba(0,0,0,0.5)] hover:border-gold-500/50"
            >
              ⏭
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                title={muted ? "Unmute" : "Mute"}
                className={`shrink-0 text-[0.5625rem] font-black uppercase tracking-[0.12em] ${
                  muted ? "text-rose-400" : "text-cream-muted"
                } hover:text-gold-300`}
              >
                {muted ? "Muted" : "Vol"}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume"
                className="woodamp-range woodamp-range-slim w-full"
              />
            </div>
          </div>

          {/* mode toggles */}
          <div className="flex items-center gap-1.5 px-0.5 pb-2 pt-2.5">
            <button
              type="button"
              onClick={toggleShuffle}
              aria-pressed={shuffle}
              className={`rounded-full border px-2.5 py-1.5 text-[0.5625rem] font-black uppercase tracking-[0.12em] transition-colors ${
                shuffle
                  ? "border-gold-500/50 bg-gold-500/15 text-gold-300"
                  : "border-gold-500/25 text-cream-muted hover:text-gold-300"
              }`}
            >
              Shuffle
            </button>
            <button
              type="button"
              onClick={toggleRepeat}
              aria-pressed={repeat}
              className={`rounded-full border px-2.5 py-1.5 text-[0.5625rem] font-black uppercase tracking-[0.12em] transition-colors ${
                repeat
                  ? "border-gold-500/50 bg-gold-500/15 text-gold-300"
                  : "border-gold-500/25 text-cream-muted hover:text-gold-300"
              }`}
            >
              Repeat
            </button>
            <button
              type="button"
              onClick={() => setShowPlaylist((v) => !v)}
              aria-expanded={showPlaylist}
              className="ml-auto rounded-full border border-gold-500/25 px-2.5 py-1.5 text-[0.5625rem] font-black uppercase tracking-[0.12em] text-cream-muted transition-colors hover:text-gold-300"
            >
              Planklist {showPlaylist ? "▴" : "▾"}
            </button>
          </div>

          {/* planklist */}
          {showPlaylist && (
            <>
              <div className="flex items-baseline justify-between px-1 pb-1.5">
                <span className="font-display text-sm tracking-[0.05em] text-gold-300">
                  Planklist
                </span>
                <span className="text-[0.5625rem] font-black uppercase tracking-[0.12em] text-cream-muted">
                  {playlist.length} track{playlist.length === 1 ? "" : "s"} ·
                  community
                </span>
              </div>
              <ul className="max-h-[210px] overflow-y-auto rounded-lg border border-gold-500/25 bg-panel-strong">
                {playlist.map((t, i) => (
                  <li
                    key={t.id}
                    className="border-b border-gold-500/10 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => selectTrack(i)}
                      aria-current={i === index ? "true" : undefined}
                      className={`flex min-h-11 w-full items-center gap-2.5 px-2.5 py-1 text-left hover:bg-gold-500/10 ${
                        i === index ? "bg-gold-500/10" : ""
                      }`}
                    >
                      <span className="w-4 shrink-0 text-right text-[0.65rem] text-cream-muted tabular-nums">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-[0.78rem] ${
                            i === index ? "text-gold-300" : "text-foreground"
                          }`}
                        >
                          {t.title}
                        </span>
                        <span className="block truncate text-[0.65rem] font-normal text-cream-muted">
                          {t.artist}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full border border-gold-500/25 px-1.5 py-0.5 text-[0.5rem] font-black uppercase tracking-[0.1em] text-gold-600">
                        {t.source === "hosted" ? "Hosted" : "Remote"}
                      </span>
                      {typeof t.duration === "number" && (
                        <span className="shrink-0 text-[0.68rem] text-cream-muted tabular-nums">
                          {formatTime(t.duration)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </>
  );
}
