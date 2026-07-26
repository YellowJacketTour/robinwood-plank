import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";

const FACTS = [
  { icon: "🔥", label: "100% Burnt Liquidity" },
  { icon: "🧾", label: "0 buy/sell taxes" },
  { icon: "🚫", label: "0 limits" },
  { icon: "🔒", label: "Ownership renounced to dead address" },
];

export default function TrustFacts() {
  return (
    <section id="trust" className="section-tight px-3 sm:px-5">
      <div className="site-shell">
        <Reveal>
          <SectionHead eyebrow="On-chain" title="Locked Down" />
        </Reveal>

        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 sm:gap-3">
          {FACTS.map((f, i) => (
            <Reveal key={f.label} delayMs={i * 80}>
              <li className="dense-card flex flex-col items-center gap-1.5 p-3 text-center">
                <span className="text-2xl" aria-hidden="true">
                  {f.icon}
                </span>
                <span className="font-display text-sm text-foreground sm:text-base">
                  {f.label}
                </span>
              </li>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
