import Reveal from "@/components/Reveal";

const ROWS = [
  {
    icon: "🪵",
    label: "RobinWood NFT Holders",
    value: 4.2069,
    display: "4.2069%",
    color: "bg-gold-500",
  },
  {
    icon: "💧",
    label: "$PLANK Initial Pool",
    value: 45,
    display: "45%",
    color: "bg-forest-600",
  },
  {
    icon: "📈",
    label: "Treasury (DEX & CEX listings)",
    value: 50,
    display: "50%",
    color: "bg-wood-600",
  },
];

export default function Distribution() {
  return (
    <section id="tokenomics" className="px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">Distribution</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Where every bit of RobinWood value flows.
          </p>
        </Reveal>

        <div className="mt-12 space-y-6">
          {ROWS.map((row, i) => (
            <Reveal key={row.label} delayMs={i * 100}>
              <div className="rounded-xl border border-gold-500/20 bg-wood-900/50 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <span aria-hidden="true">{row.icon}</span>
                    {row.label}
                  </span>
                  <span className="font-display text-gold-300">{row.display}</span>
                </div>
                <div
                  className="mt-3 h-3 w-full overflow-hidden rounded-full bg-black/30"
                  role="img"
                  aria-label={`${row.label}: ${row.display} of supply`}
                >
                  <div
                    className={`h-full rounded-full ${row.color}`}
                    style={{ width: `${Math.min(row.value, 100)}%` }}
                  />
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delayMs={300}>
          <div className="mt-8 rounded-xl border-2 border-dashed border-gold-500/40 bg-forest-900/40 p-5 text-sm text-foreground/80">
            <p>
              <span aria-hidden="true">👨🏻‍⚖️</span> The remaining <strong>≈0.8%</strong> of supply is airdropped
              to the single largest secondary purchaser of a RobinWood NFT within 1 week of mint-out. Log your
              purchase on-chain to be eligible.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
