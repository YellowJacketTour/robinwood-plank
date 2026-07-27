const STAGES = [
  { label: "Seaport live", done: true },
  { label: "Liquidity vault", done: false },
  { label: "Third-party audit", done: false },
];

/**
 * The only thing MARKET_ENABLED=false renders. No mock listings, no fake
 * "connect wallet" button — nothing that could look like a live product
 * when it isn't one. See docs/marketplank/SPEC.md §7.
 */
export default function ComingSoonGate() {
  return (
    <div className="wood-ledger mx-auto max-w-md space-y-4 p-5 text-center sm:p-6">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.28em] text-gold-300/90">
        Marketplank
      </p>
      <h3 className="font-display text-2xl text-gold-300 sm:text-3xl">Almost open</h3>
      <ul className="mx-auto flex max-w-xs justify-between gap-2">
        {STAGES.map((s) => (
          <li key={s.label} className="flex flex-1 flex-col items-center gap-1.5">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-sm font-bold ${
                s.done
                  ? "border-emerald-500 bg-emerald-500 text-wood-950"
                  : "border-gold-500/40 text-gold-300/50"
              }`}
              aria-hidden="true"
            >
              {s.done ? "✓" : "—"}
            </span>
            <span className="text-[0.6rem] font-bold uppercase tracking-wide text-foreground/70">
              {s.label}
            </span>
          </li>
        ))}
      </ul>
      <a
        href="#trade"
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-gold-500/40 bg-wood-900/60 px-4 text-sm font-bold text-gold-300 transition hover:border-gold-400"
      >
        Trade on Uniswap instead ↗
      </a>
    </div>
  );
}
