"use client";

/**
 * Single shared source of truth for wallet connection state.
 *
 * Before this existed, every consumer (SwapWidget, ZeroXCrossChainPanel,
 * Nav) called lib/wallet's getConnectedAccounts() and kept its OWN
 * useState, and only one of them (SwapWidget) subscribed to
 * accountsChanged/chainChanged. That let the nav show "Connect wallet"
 * while a trade panel simultaneously showed a connected address — the
 * owner-reported bug. Mount <WalletProvider> once in app/layout.tsx and
 * everything reads/writes through useWallet() instead of re-deriving its
 * own copy.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connectWallet,
  ensureRobinhoodChain,
  getChainId,
  getConnectedAccounts,
  getEthereumProvider,
  type Eip1193Provider,
} from "@/lib/wallet";
import ConnectWalletModalSwitch from "@/components/ConnectWalletModalSwitch";

export type WalletStatus = "disconnected" | "connecting" | "connected";

export type WalletContextValue = {
  address: string | null;
  chainId: number | null;
  status: WalletStatus;
  isConnected: boolean;
  /** Default connect path (browser extension) — same behavior as the old
   * per-component connectWallet() call, now fanned out to every consumer. */
  connect: () => Promise<string>;
  /** Clears local session state only. Injected wallets have no programmatic
   * disconnect (EIP-1193 doesn't define one) — this mirrors the "forget this
   * site" pattern most dapps use; the wallet itself stays connected until
   * the user disconnects there too. */
  disconnect: () => void;
  /** Adopt an address obtained via a connect path this context doesn't own
   * itself (e.g. ConnectWalletModal's WalletConnect QR flow, or
   * connectInjectedWallet() called directly). Re-binds provider listeners
   * to whatever is active afterward. */
  adoptAccount: (address: string) => void;
  /** Re-check eth_accounts + chain without prompting. Safe to call anytime. */
  refresh: () => Promise<void>;
  /**
   * Open the wallet-chooser modal from anywhere. The modal is mounted once
   * here, at the provider, so every surface can offer "Connect wallet"
   * without navigating: the nav button used to link to /market?connect=1,
   * which threw an admin (or anyone on any other page) out to the market
   * just to connect.
   */
  openConnect: () => void;
  closeConnect: () => void;
  connectOpen: boolean;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const activeProviderRef = useRef<Eip1193Provider | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  // The modal's chunk (and, under Reown, AppKit itself) should not load on
  // every page just because the provider wraps the whole app — so it is not
  // rendered until someone actually asks to connect. It stays mounted after
  // that, to keep the connector's own state across open/close.
  const [connectMounted, setConnectMounted] = useState(false);

  const applyAccounts = useCallback((accounts: string[] | undefined) => {
    const next = accounts?.[0] ?? null;
    setAddress(next);
    setStatus(next ? "connected" : "disconnected");
    if (!next) setChainId(null);
  }, []);

  const onAccountsChanged = useCallback(
    (...args: unknown[]) => applyAccounts(args[0] as string[] | undefined),
    [applyAccounts]
  );

  const onChainChanged = useCallback(() => {
    void getChainId().then(setChainId).catch(() => undefined);
  }, []);

  /**
   * Subscribe to whichever provider is currently active (injected
   * extension or WalletConnect). Rebinds only when the instance actually
   * changed — e.g. a WalletConnect pairing replaces the injected provider
   * lib/wallet.ts's getEthereumProvider() returns — so there is never more
   * than one live listener pair regardless of how many consumers exist.
   */
  const bindActiveProvider = useCallback(() => {
    const provider = getEthereumProvider();
    if (provider === activeProviderRef.current) return;
    const prev = activeProviderRef.current;
    prev?.removeListener?.("accountsChanged", onAccountsChanged);
    prev?.removeListener?.("chainChanged", onChainChanged);
    activeProviderRef.current = provider;
    provider?.on?.("accountsChanged", onAccountsChanged);
    provider?.on?.("chainChanged", onChainChanged);
  }, [onAccountsChanged, onChainChanged]);

  const refresh = useCallback(async () => {
    bindActiveProvider();
    const accounts = await getConnectedAccounts();
    applyAccounts(accounts);
    if (accounts[0]) {
      try {
        setChainId(await getChainId());
      } catch {
        /* keep prior chain id — a transient read failure shouldn't drop it */
      }
    }
  }, [applyAccounts, bindActiveProvider]);

  const adoptAccount = useCallback(
    (addr: string) => {
      bindActiveProvider();
      setAddress(addr);
      setStatus("connected");
      void getChainId().then(setChainId).catch(() => undefined);
    },
    [bindActiveProvider]
  );

  const connect = useCallback(async () => {
    setStatus("connecting");
    try {
      const addr = await connectWallet();
      await ensureRobinhoodChain().catch(() => undefined);
      adoptAccount(addr);
      return addr;
    } catch (e) {
      // Resync from ground truth rather than guessing what status should
      // roll back to — a rejected connect while already connected must not
      // clobber the existing session.
      await refresh();
      throw e;
    }
  }, [adoptAccount, refresh]);

  const openConnect = useCallback(() => {
    setConnectMounted(true);
    setConnectOpen(true);
  }, []);

  const closeConnect = useCallback(() => setConnectOpen(false), []);

  const onModalConnected = useCallback(
    (addr: string) => {
      // The modal's own finish() already reports the address; this is
      // idempotent insurance so the shared context can never lag behind.
      adoptAccount(addr);
      setConnectOpen(false);
      void ensureRobinhoodChain().catch(() => undefined);
    },
    [adoptAccount]
  );

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
    setStatus("disconnected");
  }, []);

  // Mount: silently pick up a previously-authorized wallet (eth_accounts
  // never prompts) and start listening. Unmount: detach whatever is bound.
  // Reading the wallet IS synchronising with an external system, which is what
  // effects are for; the setState happens in refresh() once that read returns.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => {
      const prev = activeProviderRef.current;
      prev?.removeListener?.("accountsChanged", onAccountsChanged);
      prev?.removeListener?.("chainChanged", onChainChanged);
      activeProviderRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      chainId,
      status,
      isConnected: status === "connected" && Boolean(address),
      connect,
      disconnect,
      adoptAccount,
      refresh,
      openConnect,
      closeConnect,
      connectOpen,
    }),
    [
      address,
      chainId,
      status,
      connect,
      disconnect,
      adoptAccount,
      refresh,
      openConnect,
      closeConnect,
      connectOpen,
    ]
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {connectMounted ? (
        <ConnectWalletModalSwitch
          open={connectOpen}
          onClose={closeConnect}
          onConnected={onModalConnected}
        />
      ) : null}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet() must be used within <WalletProvider>.");
  }
  return ctx;
}
