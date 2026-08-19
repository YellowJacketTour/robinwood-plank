"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentFromHue,
  applyAccentTheme,
  loadSavedAccent,
  loadSavedAccentForAddress,
  saveAccent,
  saveAccentForAddress,
  type AccentTheme,
} from "@/lib/theme-accent";
import { useWallet } from "@/lib/wallet-context";

const PRESET_LABELS: Record<string, string> = {
  "amber-gold": "Amber Gold",
  "forest-canopy": "Forest Canopy",
  "cedar-wood": "Cedar Wood",
  "tang-citrus": "Tang Citrus",
  "wizard-violet": "Wizard Violet",
};

/** Swatch preview color -- mid lightness stop, full saturation, so each button reads as its actual hue rather than the pale/dark extremes. */
function swatchColor(t: AccentTheme): string {
  return `hsl(${t.h} ${t.s}% ${t.l400}%)`;
}

/**
 * One-tap site accent theme -- flagged live 2026-08-19 ("a site wide css
 * setting for choosing any natural tone color across the spectrum...simple
 * tap to change primary color theme"). Five researched natural-tone
 * presets (wood/forest/citrus/wizard-violet, see theme-accent.ts's own
 * header for the sourcing) plus a full 0-360 hue slider for "any color
 * across the spectrum" beyond the presets. Every choice writes the same
 * four --accent-* vars app/layout.tsx's bootstrap script reads on next
 * load, so the pick persists and never flashes back to default gold.
 */
export default function ThemeAccentPicker() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<AccentTheme>(DEFAULT_ACCENT);
  const popRef = useRef<HTMLDivElement>(null);
  const { address, isConnected } = useWallet();

  useEffect(() => {
    const saved = loadSavedAccent();
    if (saved) setTheme(saved);
  }, []);

  // Auto-load per-wallet theme on connect -- flagged live 2026-08-19. Runs
  // whenever the connected address changes (covers connect, disconnect,
  // AND switching accounts in the wallet extension mid-session, since
  // useWallet's address tracks the live provider state, not just the
  // initial connect). A wallet with no saved theme of its own falls
  // through to whatever's already showing (the generic/no-wallet
  // fallback) rather than forcing default gold on every never-before-seen
  // address.
  useEffect(() => {
    if (!isConnected || !address) return;
    const perAddress = loadSavedAccentForAddress(address);
    if (perAddress) {
      setTheme(perAddress);
      applyAccentTheme(perAddress);
    }
  }, [address, isConnected]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const commit = (next: AccentTheme) => {
    setTheme(next);
    applyAccentTheme(next);
    // Always update the generic fallback (what the bootstrap script applies
    // before any wallet state is known) -- AND, if a wallet is connected,
    // also save it against that specific address so reconnecting THAT
    // wallet later (even on a different device/browser profile that shares
    // no localStorage, once synced, or simply next visit) restores it
    // instead of whatever the device's generic fallback happens to be.
    saveAccent(next);
    if (isConnected && address) saveAccentForAddress(address, next);
  };

  return (
    <div ref={popRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Change site color theme"
        title="Site color theme"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line transition-colors hover:border-line-strong"
      >
        <span
          aria-hidden="true"
          className="h-5 w-5 rounded-full border border-black/30 shadow-inner"
          style={{ backgroundColor: swatchColor(theme) }}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Site color theme"
          className="dense-card absolute right-0 top-full z-[70] mt-2 w-64 space-y-3 border-line p-3 shadow-panel"
        >
          <p className="text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Color theme</p>
          <div className="grid grid-cols-5 gap-2">
            {Object.entries(ACCENT_PRESETS).map(([key, preset]) => {
              const active = theme.h === preset.h && theme.s === preset.s && theme.l600 === preset.l600;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => commit(preset)}
                  aria-pressed={active}
                  title={PRESET_LABELS[key] ?? key}
                  className={`flex h-9 w-full items-center justify-center rounded-full border-2 transition-transform hover:scale-110 ${
                    active ? "border-foreground" : "border-black/30"
                  }`}
                  style={{ backgroundColor: swatchColor(preset) }}
                >
                  {active && <span className="h-2 w-2 rounded-full bg-white/90 shadow" aria-hidden="true" />}
                </button>
              );
            })}
          </div>

          <div className="space-y-1">
            <label htmlFor="theme-hue-slider" className="flex items-center justify-between text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
              <span>Any tone</span>
              <span className="tabular-nums text-foreground/60">{Math.round(theme.h)}°</span>
            </label>
            <input
              id="theme-hue-slider"
              type="range"
              min={0}
              max={359}
              value={theme.h}
              onChange={(e) => commit(accentFromHue(Number(e.target.value), theme))}
              className="woodamp-range w-full"
              style={{
                background: "linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red)",
              }}
              aria-label="Accent hue, any color across the spectrum"
            />
          </div>

          {theme.h !== DEFAULT_ACCENT.h || theme.s !== DEFAULT_ACCENT.s || theme.l600 !== DEFAULT_ACCENT.l600 ? (
            <button
              type="button"
              onClick={() => commit(DEFAULT_ACCENT)}
              className="w-full rounded-md border border-line px-2 py-1.5 text-xs font-bold text-foreground/60 transition-colors hover:border-line-strong hover:text-foreground/80"
            >
              Reset to Amber Gold
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
