const STAGES = [
  { label: "Seaport deployed on Robinhood Chain", done: false },
  { label: "Instant-liquidity vault deployed", done: false },
  { label: "Independent third-party audit", done: false },
];

/**
 * The only thing MARKET_ENABLED=false renders. No mock listings, no fake
 * "connect wallet" button — nothing that could look like a live product
 * when it isn't one. See docs/marketplank/SPEC.md §7.
 */
export default function ComingSoonGate() {
  return (
    <div className="wood-ledger mx-auto max-w-lg space-y-4 p-5 text-center sm:p-6">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-gold-300/90">
        Marketplank
      </p>
      <h3 className="font-display text-2xl text-gold-300 sm:text-3xl">Building in the open</h3>
      <p className="text-sm text-foreground/75">
        List, buy, sell, and make offers on RobinWood — and eventually any Robinhood Chain
        collection. Nothing here touches real funds until every gate below is cleared.
      </p>
      <ul className="mx-auto max-w-xs space-y-2 text-left">
        {STAGES.map((s) => (
          <li key={s.label} className="flex items-center gap-2.5 text-sm text-foreground/80">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                s.done
                  ? "border-emerald-500 bg-emerald-500 text-wood-950"
                  : "border-gold-500/40 text-gold-300/60"
              }`}
              aria-hidden="true"
            >
              {s.done ? "✓" : "—"}
            </span>
            {s.label}
          </li>
        ))}
      </ul>
      <a
        href="#trade"
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-gold-500/40 bg-wood-900/60 px-4 text-sm font-bold text-gold-300 transition hover:border-gold-400"
      >
        Trade $PLANK on Uniswap instead ↗
      </a>
    </div>
  );
}
