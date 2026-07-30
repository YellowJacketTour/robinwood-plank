import Reveal from "@/components/Reveal";

const FACTS = [
  { icon: "🔥", label: "100% burnt liquidity" },
  { icon: "🧾", label: "0% buy / sell tax" },
  { icon: "🚫", label: "0 wallet limits" },
  { icon: "🔒", label: "Ownership renounced" },
];

/**
 * One quiet strip of on-chain guarantees directly under the hero — per the
 * approved mockup this is a single divided row, not a titled section of
 * cards. Labels stay short enough to hold one line at every width.
 */
export default function TrustFacts() {
  return (
    <section id="trust" aria-label="On-chain guarantees" className="px-3 pb-2 pt-1 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <ul className="wood-grain-surface grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel lg:grid-cols-4">
            {FACTS.map((f, i) => (
              <li
                key={f.label}
                className={`flex items-center justify-center gap-2 px-3 py-3 text-center ${
                  i % 2 === 1 ? "border-l border-line" : ""
                } ${i >= 2 ? "border-t border-line lg:border-t-0" : ""} ${
                  i === 2 ? "lg:border-l lg:border-line" : ""
                }`}
              >
                <span className="text-lg" aria-hidden="true">
                  {f.icon}
                </span>
                <span className="text-sm font-bold text-cream">{f.label}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
