"use client";

/**
 * Reown AppKit connect surface — Phase 1 replacement for the hand-built
 * WalletConnect QR layer, behind NEXT_PUBLIC_WALLET_UI=reown (see
 * lib/wallet-reown.ts and docs/WALLET_REOWN_EVALUATION.md).
 *
 * Same props contract as the legacy <ConnectWalletModal> ({open, onClose,
 * onConnected}) so it is a drop-in for any caller once a later phase wires
 * it in — see components/ConnectWalletModalSwitch.tsx for the flag-gated
 * chooser between the two.
 *
 * AppKit supplies connect / session / provider acquisition only:
 * - The obtained EIP-1193 provider is registered via
 *   setPreferredWalletProvider() (lib/wallet-connect.ts) — the exact same
 *   plumbing lib/wallet.ts's getEthereumProvider() already reads from, so
 *   sendTransaction()/simulateTransaction()/assertSafeSwapDestination()
 *   need zero changes.
 * - The WalletConnect-vs-injected signal ensureRobinhoodChain() depends on
 *   (isWalletConnectActive()) is preserved by calling
 *   setExternalWalletConnectActive() whenever AppKit reports a
 *   'WALLET_CONNECT' connector — otherwise the Rabby-over-WalletConnect
 *   hang workaround would silently regress to the 12s timeout.
 * - This component never renders or calls AppKit's own send/swap UI (both
 *   disabled in REOWN_FEATURES); every actual transaction still goes
 *   through lib/wallet.ts.
 *
 * IMPORTANT: useAppKit()/useAppKitAccount()/useAppKitProvider()/
 * useDisconnect() throw synchronously ("Please call createAppKit before
 * using ... hook") if called before createAppKit() has run. This whole
 * file is only ever reached via a next/dynamic({ssr:false}) import (see
 * ConnectWalletModalSwitch.tsx), so createAppKit() is called once, at
 * module scope, below — by the time React renders anything from this
 * module the call has already completed (ES modules execute top-to-bottom
 * before their exports are used). ReownModalInner (the component that
 * calls the hooks) is only ever mounted from the branch where that
 * succeeded, so Rules of Hooks stay intact — no conditional hook calls.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";
import { CHAIN } from "@/lib/constants";
import {
  getReownProjectId,
  REOWN_FEATURES,
  REOWN_METADATA,
  REOWN_THEME_MODE,
  REOWN_THEME_VARIABLES,
} from "@/lib/wallet-reown";
import { setPreferredWalletProvider, setExternalWalletConnectActive } from "@/lib/wallet-connect";
import { ensureRobinhoodChain, type Eip1193Provider } from "@/lib/wallet";

const robinhoodNetwork = defineChain({
  id: CHAIN.id,
  caipNetworkId: `eip155:${CHAIN.id}` as const,
  chainNamespace: "eip155" as const,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: {
    default: { http: [CHAIN.rpcUrls.default] },
  },
  blockExplorers: {
    default: {
      name: CHAIN.blockExplorers.default.name,
      url: CHAIN.blockExplorers.default.url,
    },
  },
});

let moduleInitError: string | null = null;
try {
  const projectId = getReownProjectId();
  if (projectId.length < 20) {
    throw new Error(
      "Missing WalletConnect/Reown Project ID (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) — same credential as the legacy path, free at cloud.reown.com."
    );
  }
  createAppKit({
    adapters: [new EthersAdapter()],
    networks: [robinhoodNetwork],
    defaultNetwork: robinhoodNetwork,
    projectId,
    metadata: {
      ...REOWN_METADATA,
      icons: [...REOWN_METADATA.icons],
      url: typeof window !== "undefined" ? window.location.origin : "https://plank.love",
    },
    themeMode: REOWN_THEME_MODE,
    themeVariables: REOWN_THEME_VARIABLES,
    // AppKit's Features type uses its own string unions (SocialProvider,
    // ConnectMethod, ConnectorTypeOrder). Our config is authored as plain
    // literals in lib/wallet-reown.ts so it stays readable and diffable, so
    // it's asserted here rather than importing four internal union types.
    features: { ...REOWN_FEATURES } as Parameters<typeof createAppKit>[0]["features"],
  });
} catch (e) {
  moduleInitError = e instanceof Error ? e.message : "AppKit init failed.";
}

type Props = {
  open: boolean;
  onClose: () => void;
  onConnected: (address: string) => void;
};

function ErrorPanel({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
    >
      <div className="max-w-md rounded-2xl border border-gold-500/40 bg-wood-950 p-5 shadow-2xl">
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-gold-400/80">
          Connect wallet
        </p>
        <h2 className="mt-1 font-display text-xl text-gold-300">Could not start Reown</h2>
        <p className="mt-2 text-sm text-cream-muted">{message}</p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 min-h-10 w-full rounded-lg border border-gold-500/30 text-xs font-bold text-gold-200 hover:border-gold-400"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** Only ever mounted once createAppKit() has already succeeded — safe to
 * call every AppKit hook unconditionally here. */
function ReownModalInner({ open, onClose, onConnected }: Props) {
  const { open: openAppKitModal, close: closeAppKitModal } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider, walletProviderType } = useAppKitProvider<Eip1193Provider>("eip155");
  const { disconnect } = useDisconnect();
  const finishedForAddress = useRef<string | null>(null);

  // Open AppKit's own modal (themed via createAppKit's themeMode/
  // themeVariables above) whenever this surface is asked to open. AppKit
  // renders its overlay itself (appended to <body> by createAppKit) —
  // there is no local modal markup to render here.
  useEffect(() => {
    if (!open) return;
    void openAppKitModal({ view: "Connect" });
  }, [open, openAppKitModal]);

  // Keep lib/wallet.ts's provider selection and WalletConnect-active signal
  // in sync with whatever AppKit's Ethers adapter currently reports.
  useEffect(() => {
    if (!isConnected || !walletProvider) return;
    setPreferredWalletProvider(walletProvider);
    setExternalWalletConnectActive(walletProviderType === "WALLET_CONNECT");
  }, [isConnected, walletProvider, walletProviderType]);

  useEffect(() => {
    if (!open || !isConnected || !address) return;
    if (finishedForAddress.current === address) return;

    let cancelled = false;
    void (async () => {
      // Best-effort chain nudge — same call the legacy modal makes.
      // sendTransaction() re-checks the chain immediately before every
      // broadcast regardless, so this is a UX nicety, not a safety gate.
      await ensureRobinhoodChain().catch(() => undefined);
      if (cancelled) return;
      finishedForAddress.current = address;
      onConnected(address);
      void closeAppKitModal();
      onClose();
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isConnected, address, onConnected, onClose, closeAppKitModal]);

  // Reset our own "finished" latch when a session is torn down so a later
  // reconnect with the same address can complete again.
  useEffect(() => {
    if (!isConnected) finishedForAddress.current = null;
  }, [isConnected]);

  // `disconnect` is kept bound here (not just imported) so a future
  // explicit "disconnect" affordance on this surface has a working handle
  // without another render pass wiring it up.
  void disconnect;
  return null;
}

export default function ConnectWalletModalReown({ open, onClose, onConnected }: Props) {
  const handleClose = useCallback(() => onClose(), [onClose]);

  if (!open) return null;
  if (moduleInitError) return <ErrorPanel message={moduleInitError} onClose={handleClose} />;
  return <ReownModalInner open={open} onClose={onClose} onConnected={onConnected} />;
}
