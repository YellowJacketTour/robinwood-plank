"use client";

import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/trade";

type Props = { account: string };

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function formatEth(wei: bigint): string {
  const whole = wei / BigInt("1000000000000000000");
  const frac = wei % BigInt("1000000000000000000");
  const frac4 = (frac + BigInt("1000000000000000000")).toString().slice(1, 5);
  return `${whole}.${frac4}`;
}

/**
 * Address + native balance. Read-only: this component never builds, signs, or
 * sends a transaction, so it deliberately does not go through lib/wallet.ts.
 */
export default function WalletChip({ account }: Props) {
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    const provider = (globalThis as { ethereum?: Eip1193 }).ethereum;
    if (!provider) return;
    let cancelled = false;

    const read = () => {
      provider
        .request({ method: "eth_getBalance", params: [account, "latest"] })
        .then((hex) => {
          if (!cancelled && typeof hex === "string") setBalance(formatEth(BigInt(hex)));
        })
        // A failed balance read shows nothing rather than a misleading zero.
        .catch(() => {
          if (!cancelled) setBalance(null);
        });
    };

    read();
    const onBlock = () => read();
    provider.on?.("chainChanged", onBlock);
    return () => {
      cancelled = true;
      provider.removeListener?.("chainChanged", onBlock);
    };
  }, [account]);

  return (
    <span className="flex min-h-9 items-center gap-2 rounded-lg border border-gold-500/30 px-2.5 text-xs">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
      <span className="font-bold text-foreground">{shortAddress(account)}</span>
      {balance !== null && <span className="text-gold-300">{balance} Ξ</span>}
    </span>
  );
}
