"use client";

import { useCallback, useEffect, useState } from "react";
import { MARKET_OFFER_CURRENCY } from "@/lib/constants";
import { formatTokenAmount } from "@/lib/trade";
import { getErc20Balance } from "@/lib/wallet";

type Props = {
  account: string;
};

type Eip1193 = {
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

/** Read-only WETH balance for the Offers workspace. */
export default function WethBalance({ account }: Props) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getErc20Balance(MARKET_OFFER_CURRENCY, account);
      setBalance(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [account]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void refresh();
    });
    const provider = (globalThis as { ethereum?: Eip1193 }).ethereum;
    const onWalletChange = () => refresh();
    provider?.on?.("chainChanged", onWalletChange);
    provider?.on?.("accountsChanged", onWalletChange);
    return () => {
      window.cancelAnimationFrame(frame);
      provider?.removeListener?.("chainChanged", onWalletChange);
      provider?.removeListener?.("accountsChanged", onWalletChange);
    };
  }, [refresh]);

  return failed ? (
    <button
      type="button"
      onClick={() => void refresh()}
      className="inline-flex min-h-9 items-center rounded-full border border-red-500/30 bg-panel-strong px-3 text-xs text-red-200"
      title="Retry WETH balance"
    >
      WETH unavailable · Retry
    </button>
  ) : (
    <span
      className="inline-flex min-h-9 items-center rounded-full border border-line bg-panel-strong px-3 text-xs text-gold-300"
      title={MARKET_OFFER_CURRENCY}
    >
      WETH balance {balance === null ? "…" : formatTokenAmount(balance, 18, 5)}
    </span>
  );
}
