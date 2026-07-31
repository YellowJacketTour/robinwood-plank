"use client";

/**
 * Site-wide migration reminder. Appears on any page once a wallet is connected
 * AND that wallet holds value in a retiring vault (shares, LP, owned planks, or
 * a pending redeem). Links to /migrate. "Later" dismisses for the session.
 *
 * Sits as a sibling of SiteBanner (the admin announcement bar). Deliberately an
 * inset gradient-outline card, not a second full-width gold bar, so two
 * reminders never stack as identical blocks. z-index stays under the sticky nav.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@/lib/wallet-context";
import { useLegacyPosition } from "@/lib/market/useLegacyPosition";
import { formatShares } from "@/lib/market/migration";
import { MARKET_ENABLED } from "@/lib/constants";

const DISMISS_KEY = "plank-migrate-banner-dismissed-v1";

export default function MigrateBanner() {
  const pathname = usePathname();
  const { address, isConnected } = useWallet();
  // Poll only when the market is enabled and we're not already on /migrate.
  const onMigrate = pathname === "/migrate";
  const pos = useLegacyPosition(isConnected ? address : null, MARKET_ENABLED && !onMigrate);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!MARKET_ENABLED || onMigrate || !isConnected || dismissed || !pos.hasValue) {
    return null;
  }

  const totalShares =
    pos.plan?.sources.reduce((sum, s) => sum + s.totalShares, BigInt(0)) ?? BigInt(0);
  const planks = pos.plan?.totalRedeemableNfts ?? 0;

  const detail =
    totalShares > BigInt(0)
      ? `Your wallet holds ${formatShares(totalShares, 2)} shares in a retiring vault`
      : pos.owned.length > 0
        ? `You have ${pos.owned.length} plank${pos.owned.length === 1 ? "" : "s"} to move into the current vault`
        : "You have a pending redeem to finish";

  return (
    <div
      data-market-shell
      role="status"
      className="relative z-[55] mx-auto mt-2 flex max-w-[1220px] items-center gap-3 rounded-xl border border-line-strong bg-gradient-to-r from-gold-500/15 to-gold-500/5 px-3.5 py-2.5 sm:px-4"
    >
      <span className="h-2.5 w-2.5 flex-none rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]" />
      <p className="min-w-0 flex-1 text-sm text-cream">
        <b className="text-gold-300">The old vaults are retiring.</b> {detail}
        {planks > 0 ? ` — move your plank${planks === 1 ? "" : "s"} in a few clicks.` : "."}
      </p>
      <Link
        href="/migrate"
        className="inline-flex min-h-[44px] flex-none items-center rounded-lg bg-gold-500 px-4 text-sm font-black tracking-wide text-[#261105]"
      >
        Migrate now
      </Link>
      <button
        type="button"
        onClick={() => {
          try {
            window.sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        className="flex-none text-[0.72rem] font-bold text-cream-muted underline"
      >
        Later
      </button>
    </div>
  );
}
