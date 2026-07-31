"use client";

import {
  GASLESS_SWAPS_ENABLED,
  MARKET_ENABLED,
  RULES_RELAXED,
  TRADE_PAUSED,
} from "@/lib/constants";
import { sanitizeFlags, type FlagsDoc } from "@/lib/content-docs";
import { CardChrome, useContentDocCard } from "./contentDocCard";
import { CARD, LABEL, NOTE_MUTED } from "../ui";

/**
 * Flags section.
 *
 * Env card: the build-baked NEXT_PUBLIC_ flag values this release shipped
 * with — read-only, changing them is a rebuild by definition.
 *
 * Override card: runtime overrides stored in the database. Today that's trade pause,
 * because /api/trade/status is a server-side consumption path the clients
 * already poll. Pausing takes effect within a minute everywhere; UNPAUSING
 * via override only convinces surfaces that trust the API — a bundle baked
 * with TRADE_PAUSED=true stays paused until rebuilt (clients OR the two).
 */

const ENV_FLAGS = [
  { name: "TRADE_PAUSED", value: TRADE_PAUSED },
  { name: "MARKET_ENABLED", value: MARKET_ENABLED },
  { name: "RULES_RELAXED", value: RULES_RELAXED },
  { name: "GASLESS_SWAPS_ENABLED", value: GASLESS_SWAPS_ENABLED },
];

export default function FlagsSection({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist } =
    useContentDocCard<FlagsDoc>("flags", sanitizeFlags, address);

  return (
    <>
      <section className={CARD}>
        <h2 className="font-display text-xl text-gold-300">Release flags</h2>
        <p className={`mt-1 ${LABEL}`}>Baked into this build — read-only</p>
        <ul className="mt-4 grid gap-1 sm:grid-cols-2">
          {ENV_FLAGS.map((flag) => (
            <li
              key={flag.name}
              className="flex items-center justify-between gap-2 rounded-md bg-panel-strong px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs text-cream">{flag.name}</span>
              <span
                className={`text-[0.6875rem] font-black uppercase tracking-[0.12em] ${
                  flag.value ? "text-emerald-400" : "text-cream-muted"
                }`}
              >
                {String(flag.value)}
              </span>
            </li>
          ))}
        </ul>
        <p className={NOTE_MUTED}>
          These are NEXT_PUBLIC_ env values compiled into the release. Changing
          them is a deployment; the override below is the runtime lever.
        </p>
      </section>

      <CardChrome
        title="Trade pause override"
        subtitle="Runtime — takes effect without a deployment"
        dirty={dirty}
        save={save}
        onReload={() => void load()}
        onSave={() => void persist()}
        canSave={!!address && doc !== null}
      >
        {doc === null ? (
          <p className="mt-3 text-sm text-cream-muted">Loading…</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {(
                [
                  { value: null, label: "No override (env decides)" },
                  { value: true, label: "Force PAUSED" },
                  { value: false, label: "Force live" },
                ] as const
              ).map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() =>
                    mutate(() => ({ tradePaused: option.value }))
                  }
                  aria-pressed={doc.tradePaused === option.value}
                  className={`inline-flex min-h-11 items-center rounded-md border px-4 text-[0.6875rem] font-black uppercase tracking-[0.12em] transition-colors ${
                    doc.tradePaused === option.value
                      ? option.value === true
                        ? "border-rose-400/60 bg-rose-400/15 text-rose-400"
                        : "border-gold-500/60 bg-gold-500/15 text-gold-300"
                      : "border-line bg-panel-strong text-cream-muted hover:border-line-strong"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className={NOTE_MUTED}>
              Pausing reaches every surface within its next /api/trade/status
              poll. &ldquo;Force live&rdquo; only unpauses surfaces that trust
              the API — a build shipped with TRADE_PAUSED=true stays paused
              until redeployed.
            </p>
          </>
        )}
      </CardChrome>
    </>
  );
}
