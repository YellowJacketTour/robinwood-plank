"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

const SEEN_KEY = "plank-intro-seen";
/** Total time the overlay stays interactive-blocking before it starts
 * fading out — the "about 2 seconds" the animation itself gets to play. */
const HOLD_MS = 2000;
const FADE_OUT_MS = 350;

/**
 * First-visit-only intro: an orange "plank fruit" coalesces from nothing,
 * then settles into a tree canopy that reveals as the site's own mascot
 * face — built entirely from CSS (radial-gradient glow, keyframe scale/
 * translate, the existing plank-head.webp for the face) since there's no
 * video-rendering pipeline available here to produce an actual 3D/After
 * Effects render. Shown once ever per browser (localStorage-gated), not on
 * every page navigation within a visit.
 */
export default function SplashIntro() {
  const [phase, setPhase] = useState<"hidden" | "playing" | "leaving">("hidden");

  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // localStorage unavailable (private mode, etc.) — just skip the intro
      // rather than risk it replaying forever.
    }
    if (seen) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setPhase("playing");
    const holdMs = reduceMotion ? 400 : HOLD_MS;

    const leaveTimer = setTimeout(() => setPhase("leaving"), holdMs);
    const doneTimer = setTimeout(() => {
      setPhase("hidden");
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // nothing to do — worst case it plays again next visit
      }
    }, holdMs + FADE_OUT_MS);

    return () => {
      clearTimeout(leaveTimer);
      clearTimeout(doneTimer);
    };
  }, []);

  if (phase === "hidden") return null;

  return (
    <div
      className={`fixed inset-0 z-[999] flex items-center justify-center bg-[#0c0703] transition-opacity duration-300 ${
        phase === "leaving" ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_OUT_MS}ms` }}
      aria-hidden="true"
    >
      <div className="relative h-64 w-64">
        {/* The fruit: a glowing orange sphere that scales into existence
            with a couple of outward light-pulse rings. */}
        <div className="splash-fruit absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        <div className="splash-ring absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full" />
        <div className="splash-ring splash-ring-2 absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full" />

        {/* The tree: simple trunk + canopy silhouette the fruit settles
            into, canopy revealing the mascot face as its own "face". */}
        <div className="splash-tree absolute inset-0 flex flex-col items-center justify-end">
          <div className="splash-canopy relative flex h-40 w-40 items-center justify-center rounded-full">
            <div className="splash-face relative h-24 w-24 overflow-hidden rounded-full">
              <Image src="/images/plank-head.webp" alt="" fill sizes="96px" className="object-cover" priority />
            </div>
          </div>
          <div className="splash-trunk h-10 w-6 rounded-b-sm" />
        </div>
      </div>

      <style>{`
        .splash-fruit {
          background: radial-gradient(circle at 35% 30%, #ffe4a3, #f4a83a 45%, #b35a12 85%);
          box-shadow: 0 0 40px 6px rgba(244, 168, 58, 0.65);
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.1);
          animation: splash-fruit-in 700ms cubic-bezier(0.34, 1.56, 0.64, 1) 120ms forwards,
            splash-fruit-drop 700ms ease-in 820ms forwards;
        }
        .splash-ring {
          border: 2px solid rgba(244, 168, 58, 0.55);
          opacity: 0;
          animation: splash-ring-pulse 900ms ease-out 200ms forwards;
        }
        .splash-ring-2 {
          animation-delay: 450ms;
        }
        .splash-tree {
          opacity: 0;
          animation: splash-tree-in 500ms ease-out 700ms forwards;
        }
        .splash-canopy {
          background: radial-gradient(circle at 35% 30%, #6a9b4f, #3d6b2c 60%, #24401a 100%);
          box-shadow: 0 0 30px 4px rgba(90, 150, 60, 0.35);
          transform: scale(0.85);
          animation: splash-canopy-settle 400ms ease-out 1000ms forwards;
        }
        .splash-face {
          opacity: 0;
          transform: scale(0.7);
          animation: splash-face-in 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 1250ms forwards;
        }
        .splash-trunk {
          background: linear-gradient(180deg, #6b4423, #3d2513);
        }

        @keyframes splash-fruit-in {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.1); }
          60% { opacity: 1; transform: translate(-50%, -50%) scale(1.15); }
          100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes splash-fruit-drop {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, 10%) scale(0.35); opacity: 0; }
        }
        @keyframes splash-ring-pulse {
          0% { opacity: 0.6; transform: translate(-50%, -50%) scale(0.4); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(2.4); }
        }
        @keyframes splash-tree-in {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes splash-canopy-settle {
          0% { transform: scale(0.85); }
          50% { transform: scale(1.08); }
          100% { transform: scale(1); }
        }
        @keyframes splash-face-in {
          0% { opacity: 0; transform: scale(0.7); }
          100% { opacity: 1; transform: scale(1); }
        }

        @media (prefers-reduced-motion: reduce) {
          .splash-fruit, .splash-ring, .splash-tree, .splash-canopy, .splash-face {
            animation: none !important;
          }
          .splash-fruit { opacity: 0; }
          .splash-tree { opacity: 1; }
          .splash-canopy { transform: scale(1); }
          .splash-face { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
