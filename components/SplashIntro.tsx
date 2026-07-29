"use client";

import { useEffect, useRef, useState } from "react";

const SEEN_KEY = "plank-intro-seen";
const COLORS = ["#f4c93a", "#3a7bf4", "#e2402f"]; // yellow, blue, red
const CYCLE_MS = 900;
/** Never dismiss before at least one full color cycle has played, even if
 * the page is technically "loaded" instantly (cached) — a single-frame
 * flash would just read as a glitch. */
const MIN_CYCLES = 1;
const FADE_OUT_MS = 250;

/**
 * First-visit-only loading intro: a ball expands from nothing to large and
 * back to nothing, changing color (yellow → blue → red, looping) each
 * cycle, until the page is actually ready — not a fixed timer. "Ready"
 * here is the browser's own load event (every resource — images, fonts,
 * scripts — finished), gated by a minimum of one full cycle so a
 * fully-cached instant load doesn't just flash once. Shown once ever per
 * browser (localStorage-gated).
 */
export default function SplashIntro() {
  const [phase, setPhase] = useState<"hidden" | "playing" | "leaving">("hidden");
  const [colorIndex, setColorIndex] = useState(0);
  const cyclesRef = useRef(0);
  const pageLoadedRef = useRef(false);
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
    if (pageLoadedRef.current && cyclesRef.current >= MIN_CYCLES) dismissRef.current();
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
    // often never fire a clean window "load" (audio/fonts hang) — a full-screen
    // splash that waits forever looks like "the site won't load."
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isWalletWebView =
      /Rabby|MetaMask|Coinbase|Trust|Rainbow|WebView|wv\)/i.test(ua) ||
      // Many wallet browsers report as Chrome Mobile without "Mobile Safari"
      (/Android/i.test(ua) && /Version\/4\.0/i.test(ua));
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || isWalletWebView) {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* ignore */
      }
      return;
    }

    setPhase("playing");

    const onLoad = () => {
      pageLoadedRef.current = true;
      tryFinishRef.current();
    };
    if (document.readyState === "complete") {
      onLoad();
    } else {
      window.addEventListener("load", onLoad);
    }
    // Hard cap: never block the site more than ~2.5s even if load never fires.
    const maxWait = window.setTimeout(() => {
      pageLoadedRef.current = true;
      cyclesRef.current = Math.max(cyclesRef.current, MIN_CYCLES);
      dismissRef.current();
    }, 2500);
    return () => {
      window.removeEventListener("load", onLoad);
      window.clearTimeout(maxWait);
    };
  }, []);

  if (phase === "hidden") return null;

  const handleIteration = () => {
    cyclesRef.current += 1;
    setColorIndex((i) => (i + 1) % COLORS.length);
    tryFinishRef.current();
  };

  return (
    <div
      className={`fixed inset-0 z-[999] flex items-center justify-center bg-[#0c0703] transition-opacity ${
        phase === "leaving" ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
      aria-hidden="true"
    >
      <div
        className="splash-ball h-6 w-6 rounded-full"
        style={{ background: COLORS[colorIndex], boxShadow: `0 0 50px 10px ${COLORS[colorIndex]}66` }}
        onAnimationIteration={handleIteration}
      />
      <style>{`
        .splash-ball {
          animation: splash-pulse ${CYCLE_MS}ms ease-in-out infinite;
        }
        @keyframes splash-pulse {
          0% { transform: scale(0); opacity: 0; }
          50% { transform: scale(9); opacity: 1; }
          100% { transform: scale(0); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
