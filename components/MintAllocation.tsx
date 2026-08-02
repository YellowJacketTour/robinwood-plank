import Reveal from "@/components/Reveal";

const MINT_STATS = [
  {
    icon: "🪵",
    title: "777 Community",
    desc: "Free + Wood List pool, claimed at launch.",
  },
  {
    icon: "💰",
    title: "765 Paid & Reserve",
    desc: "Paid + owner mints, claimed at launch.",
  },
  {
    icon: "🎯",
    title: "0.01 ETH",
    desc: "Original paid mint price — now history.",
  },
] as const;

/**
 * Supply-split cards. Per the approved mockup these are a continuation of
 * the "Woodpile Is Full" section, not their own titled section — so this
 * renders the card row only and MintInfo owns the heading above it.
 */
export default function MintAllocation() {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:mt-4 sm:grid-cols-3 sm:gap-4">
      {MINT_STATS.map((stat, i) => (
        <Reveal key={stat.title} delayMs={i * 80}>
          <div className="wood-grain-surface h-full rounded-xl border border-line bg-panel p-4 text-center sm:p-5">
            <div className="text-2xl sm:text-3xl" aria-hidden="true">
              {stat.icon}
            </div>
            <h3 className="mt-2 font-display text-lg text-cream sm:text-xl">{stat.title}</h3>
            <p className="mt-1 text-sm text-cream-muted">{stat.desc}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
