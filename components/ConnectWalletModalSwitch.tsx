"use client";

/**
 * Drop-in chooser between the legacy WalletConnect QR modal and the Phase 1
 * Reown AppKit surface, keyed by NEXT_PUBLIC_WALLET_UI=reown (see
 * lib/wallet-reown.ts). Both branches share one prop contract:
 *
 *   { open: boolean; onClose: () => void; onConnected: (address: string) => void }
 *
 * so any existing `<ConnectWalletModal open onClose onConnected />` call
 * site (SwapWidget.tsx, MarketView.tsx, or a future wallet-context-driven
 * surface) can be replaced with `<ConnectWalletModalSwitch ... />`
 * unchanged — onConnected still receives a plain address string either
 * way, ready to hand to a local adoptAccount() or useWallet().adoptAccount().
 *
 * With the flag off (default), this renders exactly
 * `<ConnectWalletModal {...props} />` — same component, same dynamic
 * import, same chunk. Nothing about the existing connect path changes.
 *
 * Both branches are loaded via next/dynamic (ssr:false), matching the
 * existing lazy-load convention at every current ConnectWalletModal call
 * site, so neither the legacy bundle nor the AppKit chunk is pulled into
 * the main bundle — only the one the flag selects loads, and only once
 * "Connect Wallet" is actually opened.
 */

import dynamic from "next/dynamic";
import { isReownWalletUIEnabled } from "@/lib/wallet-reown";

const LegacyConnectWalletModal = dynamic(() => import("@/components/ConnectWalletModal"), {
  ssr: false,
});

const ReownConnectWalletModal = dynamic(() => import("@/components/ConnectWalletModalReown"), {
  ssr: false,
});

type Props = {
  open: boolean;
  onClose: () => void;
  onConnected: (address: string) => void;
};

export default function ConnectWalletModalSwitch(props: Props) {
  if (isReownWalletUIEnabled()) {
    return <ReownConnectWalletModal {...props} />;
  }
  return <LegacyConnectWalletModal {...props} />;
}
