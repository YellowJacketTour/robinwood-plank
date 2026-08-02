"use client";

import {
  GASLESS_SWAPS_ENABLED,
  MARKET_ENABLED,
  RULES_RELAXED,
  TRADE_PAUSED,
} from "@/lib/constants";
import { CROSSCHAIN_ENABLED } from "@/lib/crosschain-constants";
import { sanitizeFlags, type FlagsDoc } from "@/lib/content-docs";
import { SkeletonBlock, SkeletonStatus } from "@/components/Skeleton";
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

function OverrideRow({
  label,
  value,
  options,
  dangerWhen,
  onChange,
}: {
  label: string;
  value: boolean | null;
  options: { value: boolean | null; label: string }[];
  /** Which boolean renders in the danger color when selected. */
  dangerWhen: boolean;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <div className="mt-4">
      <p className={LABEL}>{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`inline-flex min-h-11 items-center rounded-md border px-4 text-[0.6875rem] font-black uppercase tracking-[0.12em] transition-colors ${
              value === option.value
                ? option.value === dangerWhen
                  ? "border-rose-400/60 bg-rose-400/15 text-rose-400"
                  : "border-gold-500/60 bg-gold-500/15 text-gold-300"
                : "border-line bg-panel-strong text-cream-muted hover:border-line-strong"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ZEROX_ENABLED / ZEROX_CROSSCHAIN_ENABLED live in lib/zerox-server.ts, which
// pulls in server-only fetch helpers (lib/uniswap-server.ts, ZEROX_API_KEY)
// — not safe to import into this client component. Read the same
// NEXT_PUBLIC_ values directly instead; Next.js inlines them at build time
// exactly like the lib/constants.ts flags above.
const ZEROX_ENABLED =
  process.env.NEXT_PUBLIC_ZEROX_ENABLED?.trim().toLowerCase() === "true";
const ZEROX_CROSSCHAIN_ENABLED =
  process.env.NEXT_PUBLIC_ZEROX_CROSSCHAIN_ENABLED?.trim().toLowerCase() === "true";
// Raw build-time value, not lib/wallet-reown.ts's isReownWalletUIEnabled()
// (which also layers in a per-browser localStorage override) — this card
// reports what the release baked in, not the current tab's effective state.
// Not boolean like the others (it's a mode string), so it's rendered as
// plain text below rather than the on/off pill.
const WALLET_UI = (process.env.NEXT_PUBLIC_WALLET_UI || "").trim().toLowerCase();

const ENV_FLAGS: { name: string; value: boolean }[] = [
  { name: "TRADE_PAUSED", value: TRADE_PAUSED },
  { name: "MARKET_ENABLED", value: MARKET_ENABLED },
  { name: "RULES_RELAXED", value: RULES_RELAXED },
  { name: "GASLESS_SWAPS_ENABLED", value: GASLESS_SWAPS_ENABLED },
  { name: "CROSSCHAIN_ENABLED", value: CROSSCHAIN_ENABLED },
  { name: "ZEROX_ENABLED", value: ZEROX_ENABLED },
  { name: "ZEROX_CROSSCHAIN_ENABLED", value: ZEROX_CROSSCHAIN_ENABLED },
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
          <li className="flex items-center justify-between gap-2 rounded-md bg-panel-strong px-3 py-2 text-sm">
            <span className="font-mono text-xs text-cream">WALLET_UI</span>
            <span className="text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
              {WALLET_UI === "reown" ? "reown" : "legacy (unset)"}
            </span>
          </li>
        </ul>
        <p className={NOTE_MUTED}>
          These are NEXT_PUBLIC_ env values compiled into the release. Changing
          them is a deployment; the override below is the runtime lever.
        </p>
      </section>

      <CardChrome
        title="Runtime overrides"
        subtitle="Take effect without a deployment"
        dirty={dirty}
        save={save}
        onReload={() => void load()}
        onSave={() => void persist()}
        canSave={!!address && doc !== null}
      >
        {doc === null ? (
          <div className="mt-3">
            <SkeletonStatus>Loading runtime overrides</SkeletonStatus>
            {[0, 1].map((i) => (
              <div key={i} className="mt-4">
                <SkeletonBlock className="h-2.5 w-24" />
                <div className="mt-2 flex flex-wrap gap-2">
                  <SkeletonBlock className="h-11 w-40 rounded-md" />
                  <SkeletonBlock className="h-11 w-28 rounded-md" />
                  <SkeletonBlock className="h-11 w-24 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <OverrideRow
              label="Trade pause"
              value={doc.tradePaused}
              dangerWhen={true}
              options={[
                { value: null, label: "No override (env decides)" },
                { value: true, label: "Force PAUSED" },
                { value: false, label: "Force live" },
              ]}
              onChange={(value) => mutate((prev) => ({ ...prev, tradePaused: value }))}
            />
            <OverrideRow
              label="Marketplank (/market)"
              value={doc.marketEnabled}
              dangerWhen={false}
              options={[
                { value: null, label: "No override (env decides)" },
                { value: false, label: "Force COMING SOON gate" },
                { value: true, label: "Force enabled" },
              ]}
              onChange={(value) =>
                mutate((prev) => ({ ...prev, marketEnabled: value }))
              }
            />
            <p className={NOTE_MUTED}>
              Trade pause: pausing reaches every surface within its next
              /api/trade/status poll; &ldquo;Force live&rdquo; only unpauses
              surfaces that trust the API — a build shipped with
              TRADE_PAUSED=true stays paused until redeployed. Marketplank is
              decided server-side per request, so both directions work fully.
              RULES_RELAXED has no runtime override on purpose: it relaxes
              trade protections and stays a reviewed env change.
            </p>
          </>
        )}
      </CardChrome>
    </>
  );
}
