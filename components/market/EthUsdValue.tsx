"use client";

import { useEffect, useState } from "react";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { swrJson } from "@/lib/market/swr-fetch";

type EthUsdResponse = { ethUsd?: number | null };

/** Shared best-effort ETH/USD reference for display-only marketplace estimates. */
export function useEthUsd(): number {
  const [ethUsd, setEthUsd] = useState(0);

  useEffect(() => {
    let cancelled = false;
    swrJson<EthUsdResponse>("/api/market/eth-price", {
      ttlMs: 12_000,
      swrMs: 60_000,
      session: true,
      isGood: (data) => {
        const value = (data as EthUsdResponse | null)?.ethUsd;
        return value == null || (typeof value === "number" && value > 0);
      },
    })
      .then((data) => {
        if (!cancelled && typeof data.ethUsd === "number" && data.ethUsd > 0) {
          setEthUsd(data.ethUsd);
        }
      })
      .catch(() => {
        // USD is supplemental; keep the ETH-only display when unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return ethUsd;
}

type Props = {
  wei: string | bigint | null | undefined;
  className?: string;
  digits?: number;
};

/** Renders an approximate USD equivalent without changing transaction values. */
export default function EthUsdValue({ wei, className, digits = 2 }: Props) {
  const ethUsd = useEthUsd();
  const usd = weiToUsd(wei, ethUsd);
  if (!(usd > 0)) return null;
  const label = `Approximate USD value at ${formatUsd(ethUsd)} per ETH`;

  return (
    <span
      className={className ?? "text-[0.65rem] text-foreground/50"}
      title={label}
      aria-label={label}
    >
      ≈ {formatUsd(usd, digits)}
    </span>
  );
}
