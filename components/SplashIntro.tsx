"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Owner direction (2026-07-30): the "Nailing the planks" intro must play on
 * EVERY visit to the homepage, not just the first — it's the workshop
 * entrance, always in front of the door, not a once-in-a-lifetime unlock.
 * There is deliberately no localStorage "seen" gate anymore (the old v2 key
 * previously played once per ~12h); this component is mounted globally in
 * app/layout.tsx (not owned here), so the homepage-only scoping happens via
 * `usePathname()` below instead of at the mount site.
 */
/** Minimum time the preloader stays up even on an instant cached load — a
 * single-frame flash would just read as a glitch, and this is also long
 * enough for the "Nailing the planks" beat to land. */
const MIN_MS = 3200;
/** Hard cap: never block the site more than this even if `load` never fires
 * (wallet in-app browsers / low-power mobile sometimes hang on fonts/audio). */
const MAX_WAIT_MS = 6000;
const FADE_OUT_MS = 500;
/** Much shorter gate for prefers-reduced-motion — the static frame still
 * needs a beat to avoid a content flash, but forcing a full 3.2s wait on a
 * user who explicitly asked for less motion/delay is its own regression. */
const REDUCED_MOTION_MIN_MS = 450;

const TOTAL_SUPPLY = 1542;

/** The plank CHARACTER only — the plain hand-drawn smiley plank (owner
 * direction: never the NFT collection art here; its colored square
 * backgrounds read as tiles, not planks, mid-animation). Variety comes
 * from per-board size/rotation in the keyframed drop, not from different
 * artwork. DESIGN.md "Plank character art" still applies: this IS the
 * character asset, not an abstract board. */
const FENCE_PLANKS = [
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
  "/images/plank-logo.webp",
];

/**
 * Homepage-only branded loading intro: eight plank boards drop into a fence
 * in a staggered sequence under the mascot, with a gold progress bar and
 * "Nailing the planks" headline (ports docs/mockups/landing-redesign's
 * finalized preloader). Dismisses once the page has actually loaded AND at
 * least MIN_MS has elapsed — not a fixed timer, so a slow connection never
 * gets cut short and a fast one never just flashes once. Plays on every visit
 * to "/" (no seen-gate), and never on any other route.
 */
export default function SplashIntro() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [phase, setPhase] = useState<"hidden" | "playing" | "leaving">("hidden");
  const [reducedMotion, setReducedMotion] = useState(false);
  const pageLoadedRef = useRef(false);
  const minTimeElapsedRef = useRef(false);
  const dismissedRef = useRef(false);

  const dismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setPhase("leaving");
    setTimeout(() => {
      setPhase("hidden");
    }, FADE_OUT_MS);
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const tryFinish = () => {
    if (pageLoadedRef.current && minTimeElapsedRef.current) dismissRef.current();
  };
  const tryFinishRef = useRef(tryFinish);
  tryFinishRef.current = tryFinish;

  useEffect(() => {
    // Homepage only — every other route (Trade, Market, Gallery, Learn,
    // Airdrop) never shows this, on any visit. Reset the dismiss guard so
    // navigating home → away → home again (client nav keeps this component
    // mounted, per DESIGN.md's "root layout stays mounted" rule) replays it.
    if (!isHome) {
      dismissedRef.current = false;
      pageLoadedRef.current = false;
      minTimeElapsedRef.current = false;
      setPhase("hidden");
      return;
    }

    // Wallet in-app browsers (Rabby / MetaMask / etc.) and low-power mobile
    // often never fire a clean window "load" (audio/fonts hang) — a
    // full-screen splash that waits forever looks like "the site won't
    // load." This is a functional workaround, unrelated to motion prefs.
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isWalletWebView =
      /Rabby|MetaMask|Coinbase|Trust|Rainbow|WebView|wv\)/i.test(ua) ||
      (/Android/i.test(ua) && /Version\/4\.0/i.test(ua));
    if (isWalletWebView) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReducedMotion(reduceMotion);

    dismissedRef.current = false;
    pageLoadedRef.current = false;
    minTimeElapsedRef.current = false;
    setPhase("playing");

    const minMs = reduceMotion ? REDUCED_MOTION_MIN_MS : MIN_MS;
    const minTimer = window.setTimeout(() => {
      minTimeElapsedRef.current = true;
      tryFinishRef.current();
    }, minMs);

    const onLoad = () => {
      pageLoadedRef.current = true;
      tryFinishRef.current();
    };
    if (document.readyState === "complete") {
      onLoad();
    } else {
      window.addEventListener("load", onLoad);
    }
    const maxWait = window.setTimeout(() => {
      pageLoadedRef.current = true;
      minTimeElapsedRef.current = true;
      dismissRef.current();
    }, MAX_WAIT_MS);

    return () => {
      window.clearTimeout(minTimer);
      window.clearTimeout(maxWait);
      window.removeEventListener("load", onLoad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHome]);

  if (phase === "hidden") return null;

  return (
    <div
      className={`fixed inset-0 z-[999] grid place-items-center overflow-hidden bg-wood-950 transition-opacity ${
        phase === "leaving" ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
      role="status"
      aria-live="polite"
    >
      <div
        aria-hidden="true"
        className="wood-grain-surface pointer-events-none absolute inset-0 opacity-70"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(219,165,63,0.16),transparent_60%)]"
      />

      {/* Now that this plays on every homepage visit (not just the first),
          a returning visitor who already knows the beat needs a fast way
          past it — 44px touch target, keyboard-reachable, doesn't shortcut
          MIN_MS for a first-time viewer since it's an explicit opt-out. */}
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-4 top-4 z-[2] flex min-h-11 items-center gap-1.5 rounded-full border border-gold-500/35 bg-black/25 px-4 text-xs font-bold text-cream-muted transition hover:border-gold-400 hover:text-gold-300 sm:right-6 sm:top-6"
      >
        Skip
        <span aria-hidden="true">→</span>
      </button>

      <div className="relative z-[1] flex flex-col items-center gap-5 px-5 text-center">
        <p className="text-[0.68rem] font-black uppercase tracking-[0.24em] text-gold-300/90">
          Warming the workshop
        </p>

        <div className="relative flex h-[148px] w-[min(360px,82vw)] items-end justify-center" aria-hidden="true">
          {FENCE_PLANKS.map((src, index) => (
            // Wrapper carries the per-board jitter (the drop keyframe owns
            // the img's own transform); deterministic by index so the fence
            // reads hand-built, not stamped.
            <div
              key={index}
              className="absolute bottom-0"
              style={{
                left: `${index * 46}px`,
                transform: `rotate(${((index % 2 ? 1 : -1) * (2 + ((index * 3) % 3))) / 2}deg)`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- decorative preloader art, no need for next/image optimization */}
              <img
                src={src}
                alt=""
                className={`splash-plank h-auto drop-shadow-[0_10px_14px_rgba(0,0,0,0.5)] ${
                  reducedMotion ? "opacity-100" : ""
                }`}
                style={
                  {
                    width: `${42 + ((index * 5) % 9)}px`,
                    "--drop-delay": reducedMotion ? "0ms" : `${index * 140}ms`,
                  } as React.CSSProperties
                }
              />
            </div>
          ))}
          {/* The foreman: stands at the END of the fence on the same
              baseline — centered-in-front it read as a broken ninth board
              (owner-reported). eslint-disable-next-line @next/next/no-img-element -- decorative preloader art */}
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative preloader art */}
          <img
            src="/images/plank-head.webp"
            alt=""
            className="splash-mascot absolute bottom-0 left-full h-auto w-[52px] drop-shadow-[0_10px_16px_rgba(0,0,0,0.55)]"
          />
        </div>

        <h1 className="font-display text-2xl text-gold-300 [text-shadow:0_4px_16px_rgba(0,0,0,0.7)] sm:text-3xl">
          <span className={reducedMotion ? "" : "splash-hammer inline-block"} aria-hidden="true">
            🔨
          </span>{" "}
          Nailing the planks
        </h1>
        <p className="max-w-xs text-sm font-bold text-cream-muted">
          The fence is almost up — <strong className="text-gold-400">
            {TOTAL_SUPPLY.toLocaleString()} RobinWood Planks
          </strong>{" "}
          are waiting on the other side.
        </p>

        <div className="h-2 w-[min(280px,70vw)] overflow-hidden rounded-full border border-line-strong bg-wood-950">
          <div
            className={`splash-fill h-full rounded-full bg-gradient-to-r from-gold-600 to-gold-300 ${
              reducedMotion ? "w-full" : ""
            }`}
          />
        </div>
      </div>

      <style>{`
        .splash-plank {
          opacity: 0;
          transform-origin: 50% 100%;
          /* Drop ONCE and settle (forwards) — the old infinite loop meant a
             board was always mid-air, breaking the fence line. After the
             1s drop, a staggered gentle sway keeps the fence alive without
             ever leaving the ground. */
          animation:
            splash-plank-drop 1000ms cubic-bezier(0.22, 1, 0.36, 1) forwards,
            splash-plank-sway 2400ms ease-in-out infinite;
          animation-delay: var(--drop-delay, 0ms), calc(var(--drop-delay, 0ms) + 1400ms);
        }
        @keyframes splash-plank-drop {
          0% { opacity: 0; transform: translateY(-160px) rotate(-6deg); }
          55% { opacity: 1; transform: translateY(0) rotate(0deg); }
          70% { transform: translateY(-5px) rotate(-1deg); }
          85% { transform: translateY(0) rotate(0.5deg); }
          100% { opacity: 1; transform: translateY(0) rotate(0deg); }
        }
        @keyframes splash-plank-sway {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(1.1deg); }
        }
        .splash-mascot {
          animation: splash-mascot-bob 1400ms ease-in-out infinite;
        }
        @keyframes splash-mascot-bob {
          0%, 100% { transform: rotate(-2deg); }
          50% { transform: translateY(-6px) rotate(2deg); }
        }
        .splash-fill {
          width: 4%;
          animation: splash-progress ${MIN_MS}ms cubic-bezier(0.22, 0.8, 0.3, 1) forwards;
        }
        @keyframes splash-progress {
          0% { width: 4%; }
          70% { width: 78%; }
          100% { width: 100%; }
        }
        .splash-hammer {
          animation: splash-hammer-swing 620ms ease-in-out infinite;
        }
        @keyframes splash-hammer-swing {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-24deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .splash-plank,
          .splash-hammer {
            animation: none !important;
            opacity: 1 !important;
            transform: none !important;
          }
          .splash-mascot {
            animation: none !important;
            transform: translateX(-50%) !important;
          }
          .splash-fill {
            animation: none !important;
            width: 100% !important;
          }
        }
      `}</style>
    </div>
  );
}
