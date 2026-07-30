import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";
import { explorerTokenUrl } from "@/lib/trade";

const NOTES = [
  {
    title: "Not a bridge",
    body: `Every swap routes to the official Uniswap Universal Router on ${CHAIN.name} — never Ethereum L1, never another chain.`,
  },
  {
    title: "Verified contract only",
    body: "The widget and every deep-link below are hard-locked to the real $PLANK contract. Always compare the address before signing.",
  },
  {
    title: "Fee is fixed, not negotiable",
    body: "The integrator fee is hard-coded server-side. No client, wallet, or extension can change it.",
  },
  {
    title: "Not financial advice",
    body: "Prices and quotes are informational. Confirm every amount in your wallet before signing.",
  },
] as const;

/**
 * Static safety copy — reads directly from the same constants the widget
 * enforces so this panel can never drift from what the code actually does.
 */
export default function TradeSafetyNotes() {
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-panel p-3">
      <p className="text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
        Trading safety
      </p>
      <ul className="space-y-2">
        {NOTES.map((note) => (
          <li key={note.title} className="rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <p className="text-xs font-bold text-gold-300">{note.title}</p>
            <p className="mt-0.5 text-[0.7rem] leading-snug text-cream-muted">{note.body}</p>
          </li>
        ))}
      </ul>
      <a
        href={explorerTokenUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="block truncate text-center text-[0.65rem] text-cream-muted underline-offset-2 hover:text-gold-300 hover:underline"
        title={CONTRACT_ADDRESS}
      >
        View contract on {CHAIN.blockExplorers.default.name} ↗
      </a>
    </div>
  );
}
