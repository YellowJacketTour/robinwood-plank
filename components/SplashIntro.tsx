"use client";

import { useEffect, useRef, useState } from "react";

const SEEN_KEY = "plank-intro-seen";
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
 * First-visit-only branded loading intro: eight plank boards drop into a
 * fence in a staggered sequence under the mascot, with a gold progress bar
 * and "Nailing the planks" headline (ports docs/mockups/landing-redesign's
 * finalized preloader). Dismisses once the page has actually loaded AND at
 * least MIN_MS has elapsed — not a fixed timer, so a slow connection never
 * gets cut short and a fast one never just flashes once. Shown once ever per
 * browser (localStorage-gated), same as the previous color-cycling splash.
 */
export default function SplashIntro() {
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
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // nothing to do — worst case it plays again next visit
      }
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
    let seen = true;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // localStorage unavailable (private mode, etc.) — just skip rather
      // than risk it replaying forever.
    }
    if (seen) return;

    // Wallet in-app browsers (Rabby / MetaMask / etc.) and low-power mobile
    // often never fire a clean window "load" (audio/fonts hang) — a
    // full-screen splash that waits forever looks like "the site won't
    // load." This is a functional workaround, unrelated to motion prefs.
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isWalletWebView =
      /Rabby|MetaMask|Coinbase|Trust|Rainbow|WebView|wv\)/i.test(ua) ||
      (/Android/i.test(ua) && /Version\/4\.0/i.test(ua));
    if (isWalletWebView) {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
      return;
    }

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReducedMotion(reduceMotion);

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
  }, []);

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
                style={{
                  width: `${42 + ((index * 5) % 9)}px`,
                  animationDelay: reducedMotion ? undefined : `${index * 140}ms`,
                }}
              />
            </div>
          ))}
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative preloader art */}
          <img
            src="/images/plank-head.webp"
            alt=""
            className="splash-mascot absolute bottom-2 left-1/2 h-auto w-[46px] -translate-x-1/2 drop-shadow-[0_10px_16px_rgba(0,0,0,0.55)]"
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
          animation: splash-plank-drop 2600ms cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }
        @keyframes splash-plank-drop {
          0% { opacity: 0; transform: translateY(-160px) rotate(-6deg); }
          22% { opacity: 1; }
          30% { transform: translateY(0) rotate(0deg); }
          34% { transform: translateY(-6px) rotate(-1deg); }
          40%, 100% { opacity: 1; transform: translateY(0) rotate(0deg); }
        }
        .splash-mascot {
          animation: splash-mascot-bob 1400ms ease-in-out infinite;
        }
        @keyframes splash-mascot-bob {
          0%, 100% { transform: translateX(-50%) rotate(-2deg); }
          50% { transform: translateX(-50%) translateY(-6px) rotate(2deg); }
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
