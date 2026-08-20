"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  DEFAULT_MELT,
  accentFromHue,
  applyAccentTheme,
  applyMeltPrefs,
  loadSavedAccent,
  loadSavedAccentForAddress,
  loadSavedMelt,
  saveAccent,
  saveAccentForAddress,
  saveMelt,
  type AccentTheme,
  type MeltPrefs,
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

function DiscoBallIcon({ size = 20 }: { size?: number }) {
  const shineId = `disco-shine-${useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id={shineId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#f8d98a" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="13" r="8" fill={`url(#${shineId})`} stroke="#1a1512" strokeWidth="1" />
      <path d="M12 5 V3 M10 3.2 L14 3.2" stroke="#f8d98a" strokeWidth="1.4" strokeLinecap="round" />
      {[
        [8, 9], [12, 8], [16, 9],
        [7.5, 13], [12, 12.5], [16.5, 13],
        [9, 17], [12, 16.5], [15, 17],
      ].map(([x, y], i) => (
        <rect key={i} x={x - 1.1} y={y - 1.1} width="2.2" height="2.2" rx="0.3" fill={["#f472b6", "#22d3ee", "#facc15", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f8d98a", "#c084fc"][i]} />
      ))}
    </svg>
  );
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
  const [melt, setMelt] = useState<MeltPrefs>(DEFAULT_MELT);
  const popRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  const { address, isConnected } = useWallet();

  // Fixed (viewport-relative), not absolute -- fixed 2026-08-19: the panel
  // used to be `absolute right-0`, positioned relative to the trigger
  // button's own wrapper. That works fine in the desktop nav row, but in
  // the mobile menu (Nav.tsx) the button lives inside a container with
  // `overflow-y-auto` -- and per a real CSS spec rule, setting overflow-y
  // to anything other than "visible" forces overflow-x to compute as
  // "auto" too if it was left at its default "visible", even though
  // nothing set overflow-x explicitly. That silently clips/scroll-boxes
  // the absolutely-positioned popup instead of letting it float over the
  // page, which is exactly what "doesn't format on screen properly on
  // mobile" describes. `position: fixed` is computed relative to the
  // viewport regardless of an ancestor's overflow, so this measures the
  // trigger button's own real screen position on open and renders the
  // panel there instead, with its own width clamped against the actual
  // viewport so it can never run off either edge on a narrow phone.
  useEffect(() => {
    if (!open || !popRef.current) {
      setPanelPos(null);
      return;
    }
    const rect = popRef.current.getBoundingClientRect();
    const panelWidth = 288; // matches the panel's own w-72
    const margin = 12;
    const left = Math.min(
      Math.max(margin, rect.right - panelWidth),
      Math.max(margin, window.innerWidth - panelWidth - margin)
    );
    setPanelPos({ top: rect.bottom + 8, left });
  }, [open]);

  useEffect(() => {
    const saved = loadSavedAccent();
    if (saved) setTheme(saved);
    const meltSaved = loadSavedMelt();
    if (meltSaved) {
      setMelt(meltSaved);
      applyMeltPrefs(meltSaved);
    }
  }, []);

  // Auto-load per-wallet theme on connect -- flagged live 2026-08-19, then
  // extended the same day to real cross-device/cross-browser sync
  // ("stays their last wallet connected style for next wallet connect
  // session any device any browser?"). Runs whenever the connected address
  // changes (covers connect, disconnect, AND switching accounts mid-
  // session, since useWallet's address tracks the live provider state).
  //
  // Two-step, server-authoritative: apply the local per-address cache
  // FIRST (instant, no flash, works offline) if one exists, then fetch the
  // server's copy -- migration 013_wallet_theme_prefs.sql -- which is the
  // real cross-device source of truth and wins if it differs (e.g. this is
  // a browser that has never seen this wallet before, or the wallet's
  // theme was changed from a different device). If the server has nothing
  // yet but this browser DOES have a local pick for this address, push it
  // up so it starts syncing from here on -- a one-time migration of
  // whatever was already chosen locally, not a silent overwrite of a real
  // server value.
  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;

    const localTheme = loadSavedAccentForAddress(address);
    if (localTheme) {
      setTheme(localTheme);
      applyAccentTheme(localTheme);
    }

    (async () => {
      try {
        const res = await fetch(`/api/wallet-theme?wallet=${encodeURIComponent(address)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { theme?: AccentTheme | null };
        if (cancelled) return;
        if (data.theme) {
          setTheme(data.theme);
          applyAccentTheme(data.theme);
          saveAccentForAddress(address, data.theme);
        } else if (localTheme) {
          void fetch("/api/wallet-theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wallet: address, theme: localTheme }),
          });
        }
      } catch {
        // Offline/unreachable -- the local per-address cache applied above
        // already covers this session; sync just doesn't happen this time.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, isConnected]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The panel is now `fixed` (positioned from a one-time measurement on
    // open, see the effect above) rather than `absolute` inside whatever
    // ancestor scrolls -- so if the mobile menu's own scroll container (or
    // the page, or an orientation change) moves, the panel would otherwise
    // stay frozen at its old coordinates and visually detach from the
    // trigger button. Closing on scroll/resize is simpler and more honest
    // than re-measuring continuously, and matches how most dropdown/
    // popover libraries handle this same tradeoff.
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("scroll", onReflow, { capture: true, passive: true });
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("scroll", onReflow, { capture: true });
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  const commit = (next: AccentTheme) => {
    setTheme(next);
    applyAccentTheme(next);
    // Always update the generic fallback (what the bootstrap script applies
    // before any wallet state is known) -- AND, if a wallet is connected,
    // the local per-address cache (instant re-apply next time this same
    // browser sees this wallet, even offline) PLUS the server record
    // (migration 013) so a DIFFERENT browser/device connecting the same
    // wallet picks this up too. The server write is fire-and-forget: the
    // UI already reflects the change instantly via applyAccentTheme above,
    // and a failed sync just means this pick stays local-only until the
    // next successful one -- never blocks or reverts what's on screen.
    saveAccent(next);
    if (isConnected && address) {
      saveAccentForAddress(address, next);
      void fetch("/api/wallet-theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, theme: next }),
      });
    }
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
        {melt.on ? (
          <DiscoBallIcon size={20} />
        ) : (
          <span
            aria-hidden="true"
            className="h-5 w-5 rounded-full border border-black/30 shadow-inner"
            style={{ backgroundColor: swatchColor(theme) }}
          />
        )}
      </button>


      {open && panelPos && (
        <div
          role="dialog"
          aria-label="Site color theme"
          className="dense-card fixed z-[70] w-72 space-y-3 border-line p-3 shadow-panel"
          style={{ top: panelPos.top, left: panelPos.left }}
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

          <div className="space-y-2 border-t border-line pt-2">
            <button
              type="button"
              aria-pressed={melt.on}
              onClick={() => {
                const next = { ...melt, on: !melt.on };
                setMelt(next);
                applyMeltPrefs(next);
                saveMelt(next);
              }}
              className={`flex min-h-10 w-full items-center justify-between rounded-md border px-2.5 text-xs font-bold ${
                melt.on ? "border-gold-400 bg-gold-400/15 text-gold-300" : "border-line text-foreground/70"
              }`}
            >
              <span>Disco melt</span>
              <DiscoBallIcon size={18} />
            </button>
            {melt.on && (
              <div className="space-y-1">
                <label htmlFor="theme-melt-bias" className="flex items-center justify-between text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">
                  <span>Technicolor → biased</span>
                  <span className="tabular-nums text-foreground/60">{Math.round(melt.bias * 100)}%</span>
                </label>
                <input
                  id="theme-melt-bias"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(melt.bias * 100)}
                  onChange={(e) => {
                    const next = { ...melt, bias: Number(e.target.value) / 100 };
                    setMelt(next);
                    applyMeltPrefs(next);
                    saveMelt(next);
                  }}
                  className="woodamp-range w-full"
                  aria-label="Melt color bias, full rainbow to accent-clustered"
                />
              </div>
            )}
          </div>

          {theme.h !== DEFAULT_ACCENT.h || theme.s !== DEFAULT_ACCENT.s || theme.l600 !== DEFAULT_ACCENT.l600 || melt.on ? (
            <button
              type="button"
              onClick={() => {
                commit(DEFAULT_ACCENT);
                setMelt(DEFAULT_MELT);
                applyMeltPrefs(DEFAULT_MELT);
                saveMelt(DEFAULT_MELT);
              }}
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
