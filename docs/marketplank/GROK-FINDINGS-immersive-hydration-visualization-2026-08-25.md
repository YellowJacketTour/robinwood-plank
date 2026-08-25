# Grok findings: immersive hydration visualization — real components delivered (2026-08-25)

Response to `GROK-RESEARCH-BRIEF-immersive-hydration-visualization-2026-08-25.md`.
Preserved verbatim below (full code included). See the bottom for the build decision.

---

**Verdict first (state of the art vs this app)**

| Technique | SOTA status | Fit for Marketplank |
|-----------|-------------|---------------------|
| Three.js + R3F + InstancedMesh | Real: 1 draw call for 10k-100k identical meshes | Overkill for a data table; ~150-175 KB gzip three + ~50 KB R3F before tree-shake; competes with rankings paint |
| WebGPU procedural wood (Three `webgpu_tsl_wood`) | Real quality; support ~Chrome/Edge/Safari 26+, Firefox uneven | Still a GPU path + fallback; not justified for 100 row chips |
| CSS `preserve-3d` flip + grain gradients | Production pattern (cards, dashboards); 0 new deps | **Right default for rankings** |
| Canvas 2D one-shot grain bar | Lightweight tactile fill | **Right for detail archive bar** |
| Decorative-only motion | -- | **Forbidden** (same as fabricating data) |

**Recommendation (tiered, not one visual language)**

| Surface | Treatment | Why |
|---------|-----------|-----|
| Rankings row (x100) | CSS plank chip + event pulse | Cost scales; no WebGL context |
| Collection detail archive depth | CSS/SVG wood bar + score fill | One instance; numbers stay in DOM |
| Hero "Trending" (optional later) | Lazy WebGL only if you ever need a single showcase | Code-split; never block first paint |
| Mover cards | Same chip as rankings, smaller | Consistency |

No Three.js dependency in this handoff. Full 3D is optional future for **one** hero, not the table.

---

## Research notes (compressed)

1. **Wood / PBR / WebGPU** -- Procedural wood via noise rings is real (Three WebGPU TSL wood example). WebGPU is mainstream on Chromium + recent Safari; Firefox still weaker. For many *tiny* instances, material quality is invisible at 12-16px; CSS grain wins on cost.
2. **Live data as tactile** -- Markets use motion on *state change* (flash, bar fill), not continuous 3D scenes. GitHub contribution graph is the right scale metaphor.
3. **Instancing** -- `InstancedMesh` solves draw calls when you *already* paid for WebGL. Paying that tax for 100 chips is the wrong problem.
4. **CSS 3D** -- `perspective` + `rotateY` + `backface-visibility` + `prefers-reduced-motion` is proven and accessible when the number stays in the accessibility tree.
5. **Where 3D is justified** -- One hero object, maybe. Not 100 rows. Say so plainly: **do not ship table WebGL.**

---

## Build: real components (Next.js + TS + Tailwind)

Assumptions matched to your constraints:

- Animate **only** when a real hydration signal flips (`active` / `pulseKey` from job completion or archival_score change).
- `archival_score: number | null`, `score_method: 'supply_ratio' | 'hits_only' | 'unknown_supply'`.
- Reduced motion -> static UI, same numbers.
- Zero new packages.

### 1) Shared reduced-motion helper

```tsx
// components/market/hydration/usePrefersReducedMotion.ts
"use client";

import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return reduced;
}
```

### 2) Rankings row: physical plank chip (CSS only)

```tsx
// components/market/hydration/HydrationPlankChip.tsx
"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type HydrationPlankChipProps = {
  /** True while a real mesh job is processing this collection */
  active?: boolean;
  /** Bump when a real hydrate/archive write completes -- drives one pulse */
  pulseKey?: string | number | null;
  /** Optional compact label for SR; visual is decorative */
  label?: string;
  className?: string;
};

/**
 * Tiny wood "plank" indicator for rankings rows.
 * Motion is event-driven only (active / pulseKey). Never decorative-loop.
 */
export function HydrationPlankChip({
  active = false,
  pulseKey = null,
  label = "Hydration activity",
  className = "",
}: HydrationPlankChipProps) {
  const reduced = usePrefersReducedMotion();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (reduced || pulseKey == null || pulseKey === "") return;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 700);
    return () => window.clearTimeout(t);
  }, [pulseKey, reduced]);

  return (
    <span
      className={[
        "relative inline-flex h-3.5 w-5 shrink-0 items-center justify-center",
        "rounded-[2px] border border-amber-900/40",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.35)]",
        // procedural-ish grain via layered gradients (no image fetch)
        "bg-[linear-gradient(90deg,rgba(0,0,0,0.12)_1px,transparent_1px),linear-gradient(180deg,#8b5a2b_0%,#a67c52_35%,#6b4226_70%,#4a2c14_100%)]",
        "bg-[length:3px_100%,100%_100%]",
        !reduced && active ? "animate-plank-glow" : "",
        !reduced && pulse ? "animate-plank-flip" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={
        active
          ? `${label}: processing`
          : pulse
            ? `${label}: updated`
            : `${label}: idle`
      }
      data-active={active ? "true" : "false"}
      data-pulse={pulse ? "true" : "false"}
    >
      {/* specular edge -- pure CSS, no WebGL */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-100/50 to-transparent"
      />
    </span>
  );
}
```

Tailwind keyframes (add to `tailwind.config` `theme.extend.keyframes` / `animation`):

```js
// tailwind.config -- extend
keyframes: {
  "plank-flip": {
    "0%": { transform: "perspective(120px) rotateX(0deg) scale(1)" },
    "40%": { transform: "perspective(120px) rotateX(55deg) scale(1.08)" },
    "100%": { transform: "perspective(120px) rotateX(0deg) scale(1)" },
  },
  "plank-glow": {
    "0%, 100%": { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 0 0 0 rgba(251,191,36,0)" },
    "50%": { boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 0 8px 1px rgba(251,191,36,0.55)" },
  },
},
animation: {
  "plank-flip": "plank-flip 0.65s ease-out",
  "plank-glow": "plank-glow 1.4s ease-in-out infinite",
},
```

**Wire in rankings row** (example):

```tsx
<HydrationPlankChip
  active={row.jobProcessing === true}
  pulseKey={row.lastArchivedAt /* or job completion id from poll */}
  label={`${row.name} archival`}
/>
```

`active` / `pulseKey` must come from real job / `collection_archival_stats` updates -- never a random timer.

---

### 3) Detail page: archival depth bar (CSS + real score in DOM)

```tsx
// components/market/hydration/ArchivalDepthBar.tsx
"use client";

import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

export type ArchivalDepthBarProps = {
  /** 0..1 when score_method is supply_ratio; null if unknown */
  archivalScore: number | null;
  scoreMethod: "supply_ratio" | "hits_only" | "unknown_supply" | string;
  tokensEverHydrated?: number | null;
  knownSupply?: number | null;
  /** Real event: score increased -- triggers fill emphasis once */
  pulseKey?: string | number | null;
  className?: string;
};

/**
 * Wood-textured archive depth bar.
 * Accessible text always present; motion is optional decoration only.
 */
export function ArchivalDepthBar({
  archivalScore,
  scoreMethod,
  tokensEverHydrated = null,
  knownSupply = null,
  pulseKey = null,
  className = "",
}: ArchivalDepthBarProps) {
  const reduced = usePrefersReducedMotion();
  const known = scoreMethod === "supply_ratio" && archivalScore != null;
  const pct = known
    ? Math.max(0, Math.min(100, Math.round(archivalScore * 100)))
    : null;

  const summary =
    known && knownSupply != null && tokensEverHydrated != null
      ? `Archive depth ${pct}% - ${tokensEverHydrated.toLocaleString()} of ${knownSupply.toLocaleString()} tokens stored`
      : tokensEverHydrated != null
        ? `Archive depth - ${tokensEverHydrated.toLocaleString()} tokens stored - supply unknown`
        : "Archive depth - not yet measured";

  return (
    <div className={["w-full", className].join(" ")}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs text-amber-100/80">
        <span className="font-medium tracking-wide text-amber-50/90">
          Archive depth
        </span>
        <span className="tabular-nums text-amber-100/70" aria-live="polite">
          {known ? `${pct}%` : "-"}
        </span>
      </div>

      <div
        className={[
          "relative h-3 w-full overflow-hidden rounded-sm",
          "border border-amber-950/60",
          "bg-[linear-gradient(90deg,rgba(0,0,0,0.2)_1px,transparent_1px),linear-gradient(180deg,#3d2412,#5c3a1e)]",
          "bg-[length:4px_100%,100%_100%]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.55)]",
        ].join(" ")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={summary}
        aria-label={summary}
      >
        {/* fill -- only when we have a real ratio; unknown stays empty track */}
        {known && (
          <div
            key={pulseKey ?? "fill"}
            className={[
              "absolute inset-y-0 left-0",
              "bg-[linear-gradient(180deg,#c4a574_0%,#8b5a2b_45%,#6b4226_100%)]",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]",
              !reduced ? "transition-[width] duration-700 ease-out" : "",
              !reduced && pulseKey != null ? "animate-plank-glow" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ width: `${pct}%` }}
          />
        )}

        {/* end-cap plank when partial progress */}
        {known && pct > 0 && pct < 100 && (
          <span
            aria-hidden
            className="absolute top-0 h-full w-0.5 bg-amber-100/40"
            style={{ left: `calc(${pct}% - 1px)` }}
          />
        )}
      </div>

      {/* Always in DOM for AT and honesty */}
      <p className="mt-1 text-[11px] leading-snug text-amber-100/55">
        {summary}
        {scoreMethod === "unknown_supply" && (
          <span className="block text-amber-100/40">
            Completeness % requires a known supply; we do not invent one.
          </span>
        )}
      </p>
    </div>
  );
}
```

---

### 4) Data wiring (honest events only)

Poll or subscribe to existing archival/job routes; map to props:

```ts
// example mapper -- use your real API shapes
type ArchivalRow = {
  archival_score: number | null;
  score_method: string;
  tokens_ever_hydrated: number | null;
  known_supply: number | null;
  last_archived_at: string | null;
};

function toBarProps(row: ArchivalRow) {
  return {
    archivalScore: row.archival_score,
    scoreMethod: row.score_method,
    tokensEverHydrated: row.tokens_ever_hydrated,
    knownSupply: row.known_supply,
    pulseKey: row.last_archived_at, // changes only on real write
  };
}
```

For rankings, `jobProcessing` should come from mesh status / visibility demand state you already expose -- not a fake interval.

---

### 5) Code-splitting strategy

These components are client-only but **tiny** (no Three). Still optional:

```tsx
// rankings: static import is fine (CSS-only)
import { HydrationPlankChip } from "@/components/market/hydration/HydrationPlankChip";

// if you later add a hero WebGL plank:
const HeroPlank = dynamic(
  () => import("@/components/market/hydration/HeroPlankWebGL"),
  { ssr: false, loading: () => null }
);
```

Do **not** add `three` / `@react-three/fiber` until a single hero surface is proven to need it; lazy-load then so rankings never wait on WebGL.

---

### 6) Labels (brief discipline)

| Piece | Label |
|-------|--------|
| CSS grain + 3D flip pulse on real events | **Adopt** known CSS 3D + dashboard flash patterns |
| Tier: table=CSS, detail=bar, hero=optional WebGL | **Adapt** for many small instances |
| Refuse table WebGL / refuse decorative loops | **Honest constraint**, not under-ambition |
| Archive bar empty when `score_method` unknown | **Compose** with never-fabricate |

---

### Bottom line

State-of-the-art *for this product* is not a forest of InstancedMesh planks on a rankings grid. It is **event-faithful, zero-dependency, reduced-motion-safe wood UI** that makes real hydration *felt* without taxing 100 rows or the marketplace's first paint. Ship the chip + depth bar above; keep WebGL as a gated hero experiment, not the default language of the app.

---

## Build decision (Sonnet 5, 2026-08-25)

Building this as delivered. Real, correct engineering judgment throughout:
refusing WebGL/Three.js for a 100-row table (correctly identifying that
material quality is invisible at 12-16px and the real bundle-size cost
isn't justified), event-driven-only motion (never a decorative loop,
matching this app's own never-fabricate discipline extended honestly
into animation), full `prefers-reduced-motion` support with the real
number always present in the DOM regardless of motion state, and the
honest empty-state for `unknown_supply` rather than hiding or faking a
percentage.

Two real integration gaps to close during the build (not present in the
handoff, since Grok didn't have live access to check): neither
`GlobalMarketHub`'s rankings API response nor any client-facing route
currently exposes `archival_score`/`tokens_ever_hydrated`/`score_method`
per collection -- `collection_archival_stats` is backend-only today.
Wiring real data into these components requires first exposing that data
through the existing multichain API routes.
