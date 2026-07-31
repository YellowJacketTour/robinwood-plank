"use client";

import { useWoodAmp } from "./WoodAmpProvider";

/**
 * WoodAmp nav entry points (see docs/mockups/woodamp once blessed):
 *
 * - <WoodAmpRailChip /> — the desktop header pill. Sits with the chain chip
 *   and Connect wallet in the right-hand rail. Uses the same control
 *   vocabulary as the chain chip (pill, gold-alpha hairline) but with the
 *   sanctioned wood-grain face so it previews the player. The marquee title
 *   only appears at xl, mirroring how the chain chip is hidden below xl —
 *   at lg the rail is too tight for both.
 *
 * - <WoodAmpMenuRow /> — the row inside the mobile disclosure menu. Opening
 *   the popout closes the menu (via onOpen) so the bottom sheet isn't
 *   fighting the menu overlay.
 *
 * Both replace the old fixed corner mute button from AudioPlayer.tsx; the
 * play control keeps its "make sound / stop sound" semantics (chipToggle).
 */

/** Shared wood-grain pill face — .site-footer-surface is the single source
 * of truth for the quiet wood texture (see globals.css). */
const WOOD_FACE =
  "site-footer-surface border border-gold-500/25 shadow-[inset_0_1px_0_rgba(233,180,63,0.1),inset_0_-2px_4px_rgba(0,0,0,0.5)]";

function PlayGlyph({ playing }: { playing: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      {playing ? (
        <>
          <rect x="1.5" y="1" width="3.2" height="10" rx="0.8" />
          <rect x="7.3" y="1" width="3.2" height="10" rx="0.8" />
        </>
      ) : (
        <path d="M2.5 1.2c0-.5.55-.8.98-.55l8.04 4.55c.44.25.44.87 0 1.12L3.48 10.9a.64.64 0 0 1-.98-.55V1.2Z" />
      )}
    </svg>
  );
}

/** Tiny animated EQ; bars freeze when nothing is audible. */
function ChipEq({ live }: { live: boolean }) {
  const heights = ["55%", "80%", "45%", "90%"];
  return (
    <span aria-hidden="true" className="flex h-4 shrink-0 items-end gap-[2px]">
      {heights.map((h, i) => (
        <i
          key={i}
          className={`woodamp-eq-bar w-[3px] rounded-[1px] bg-gold-500 ${
            live ? "" : "woodamp-eq-paused"
          }`}
          style={{ height: h, animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

/** The audible-state button shared by both variants. */
function ChipPlayButton({ compact = false }: { compact?: boolean }) {
  const { playing, muted, chipToggle } = useWoodAmp();
  const audible = playing && !muted;
  return (
    <button
      type="button"
      onClick={chipToggle}
      aria-label={audible ? "Pause music" : "Play music"}
      title={audible ? "Pause" : "Play"}
      className={`flex shrink-0 items-center justify-center rounded-full border border-gold-500/50 bg-gradient-to-b from-gold-400 to-gold-600 text-wood-950 shadow-[0_2px_5px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,242,207,0.45)] transition-transform hover:scale-105 ${
        compact ? "h-9 w-9" : "h-10 w-10"
      }`}
    >
      <PlayGlyph playing={audible} />
    </button>
  );
}

export function WoodAmpRailChip() {
  const { track, playing, muted, toggleWindow, open } = useWoodAmp();
  const live = playing && !muted;
  return (
    <div
      className={`flex min-h-11 items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5 ${WOOD_FACE}`}
    >
      <ChipPlayButton compact />
      <button
        type="button"
        onClick={toggleWindow}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? "Close WoodAmp player" : "Open WoodAmp player"}
        title="WoodAmp"
        className="flex min-h-9 items-center gap-2.5 rounded-full text-left"
      >
        <span className="hidden min-w-0 max-w-[150px] xl:block">
          <span className="block text-[0.5625rem] font-black uppercase leading-none tracking-[0.14em] text-gold-600">
            WoodAmp
          </span>
          <span className="woodamp-marquee block overflow-hidden whitespace-nowrap text-xs leading-tight text-gold-300">
            <span className={live ? "" : "woodamp-marquee-paused"}>
              {track.title} — {track.artist}&nbsp;&nbsp;·&nbsp;&nbsp;
              {track.title} — {track.artist}&nbsp;&nbsp;·&nbsp;&nbsp;
            </span>
          </span>
        </span>
        <ChipEq live={live} />
      </button>
    </div>
  );
}

export function WoodAmpMenuRow({ onOpen }: { onOpen?: () => void }) {
  const { track, playing, muted, openWindow } = useWoodAmp();
  const live = playing && !muted;
  return (
    <div
      className={`mt-3 flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 ${WOOD_FACE}`}
    >
      <ChipPlayButton />
      <span className="min-w-0 flex-1">
        <span className="block text-[0.5625rem] font-black uppercase leading-none tracking-[0.14em] text-gold-600">
          WoodAmp
        </span>
        <span className="woodamp-marquee block overflow-hidden whitespace-nowrap text-xs leading-tight text-gold-300">
          <span className={live ? "" : "woodamp-marquee-paused"}>
            {track.title} — {track.artist}&nbsp;&nbsp;·&nbsp;&nbsp;
            {track.title} — {track.artist}&nbsp;&nbsp;·&nbsp;&nbsp;
          </span>
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          onOpen?.();
          openWindow();
        }}
        className="shrink-0 rounded-full border border-gold-500/50 px-3 py-2 text-[0.5625rem] font-black uppercase tracking-[0.12em] text-gold-300 transition-colors hover:bg-gold-500/10"
      >
        Open
      </button>
    </div>
  );
}
