"use client";

import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/trade";

type ActivityEvent = {
  kind: "mint" | "sale" | "transfer";
  tokenId: string;
  from: string;
  to: string;
  priceEth: string | null;
  txHash: string;
  timestamp: string | null;
};

const KIND_STYLE: Record<ActivityEvent["kind"], string> = {
  sale: "text-gold-300",
  mint: "text-emerald-300",
  transfer: "text-foreground/50",
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Explorer confirmed reachable during the audit. */
const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";

export default function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/activity")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        if (!cancelled) setEvents(data.events ?? []);
      })
      .catch(() => {
        // Distinguish "nothing traded" from "we could not look" — showing an
        // empty feed for an RPC failure would misrepresent the collection.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="py-6 text-center text-xs text-foreground/45">Activity unavailable.</p>;
  }
  if (events === null) {
    return <p className="py-6 text-center text-xs text-foreground/45">Loading…</p>;
  }
  if (events.length === 0) {
    return <p className="py-6 text-center text-xs text-foreground/45">No activity yet.</p>;
  }

  return (
    <div className="dense-card p-0">
      {/* From/To are dropped below sm: at 390px they force a horizontal
          scroll and wrap mid-address, which reads as broken. Event, item,
          price and age are what the feed is actually for. */}
      <table className="w-full table-auto text-left text-xs">
        <thead className="text-[0.6rem] uppercase tracking-wide text-foreground/40">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Event</th>
            <th scope="col" className="px-3 py-2 font-medium">Item</th>
            <th scope="col" className="px-3 py-2 font-medium">Price</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">From</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">To</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={`${e.txHash}-${e.tokenId}`} className="border-t border-gold-500/10">
              <td className={`px-3 py-2 font-bold capitalize ${KIND_STYLE[e.kind]}`}>
                <a
                  href={`${EXPLORER_TX}${e.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {e.kind}
                </a>
              </td>
              <td className="px-3 py-2 font-bold text-foreground">#{e.tokenId}</td>
              <td className="whitespace-nowrap px-3 py-2 text-gold-300">
                {e.priceEth
                  ? `${Number(e.priceEth).toFixed(4)} Ξ`
                  : // A Seaport fill paid in WETH moves no native ETH in the
                    // transaction, so there's no on-chain value to show — a
                    // bare "—" next to "Sale" reads as broken data, not as
                    // "priced in a token we don't display."
                    e.kind === "sale"
                    ? "in WETH"
                    : "—"}
              </td>
              <td className="hidden whitespace-nowrap px-3 py-2 text-foreground/50 sm:table-cell">
                {shortAddress(e.from)}
              </td>
              <td className="hidden whitespace-nowrap px-3 py-2 text-foreground/50 sm:table-cell">
                {shortAddress(e.to)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-foreground/40">
                {ago(e.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
