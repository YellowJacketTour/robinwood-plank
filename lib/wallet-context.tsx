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
  signMessage as signWalletMessage,
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
  // Keep the selected connector mounted for the lifetime of the app. Reown
  // restores WalletConnect sessions only while its hooks are mounted.
  const [connectMounted, setConnectMounted] = useState(true);
  const pendingPlankSpaceConnects = useRef<string[]>([]);
  const walletStateRef = useRef({ address, chainId, status });
  useEffect(() => {
    walletStateRef.current = { address, chainId, status };
  }, [address, chainId, status]);

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
      for (const requestId of pendingPlankSpaceConnects.current.splice(0)) {
        window.dispatchEvent(new CustomEvent("plank:wallet-response", {
          detail: { requestId, result: { address: addr, state: { address: addr, chainId, status: "connected", isConnected: true } } },
        }));
      }
    },
    [adoptAccount, chainId]
  );

  // PlankSpace is a native route in this same Next.js app. It must use this
  // provider instead of creating/falling back to window.ethereum.
  useEffect(() => {
    const respond = (requestId: string, result?: unknown, error?: string) => {
      window.dispatchEvent(new CustomEvent("plank:wallet-response", {
        detail: { requestId, result, error },
      }));
    };
    const onRequest = (raw: Event) => {
      const detail = (raw as CustomEvent).detail as { requestId: string; method: string; payload?: { address?: string; message?: string } };
      if (!detail?.requestId) return;
      void (async () => {
        try {
          if (detail.method === "getState") {
            const current = walletStateRef.current;
            respond(detail.requestId, { state: { ...current, isConnected: Boolean(current.address) } });
          } else if (detail.method === "connect") {
            const current = walletStateRef.current;
            if (current.address) respond(detail.requestId, { address: current.address, state: { ...current, status: "connected", isConnected: true } });
            else {
              let restored: string | null = null;
              for (let attempt = 0; attempt < 8 && !restored; attempt += 1) {
                const accounts = await getConnectedAccounts();
                restored = accounts[0] || walletStateRef.current.address;
                if (!restored) await new Promise(resolve => window.setTimeout(resolve, 250));
              }
              if (restored) {
                adoptAccount(restored);
                respond(detail.requestId, { address: restored, state: { address: restored, chainId: walletStateRef.current.chainId, status: "connected", isConnected: true } });
                return;
              }
              pendingPlankSpaceConnects.current.push(detail.requestId);
              openConnect();
            }
          } else if (detail.method === "ensureRobinhoodChain") {
            await ensureRobinhoodChain();
            await refresh();
            const current = walletStateRef.current;
            respond(detail.requestId, { state: { ...current, isConnected: Boolean(current.address) } });
          } else if (detail.method === "signMessage") {
            const currentAddress = walletStateRef.current.address;
            if (!currentAddress || !detail.payload?.message) throw new Error("Connect your Plank.love wallet first.");
            if (detail.payload.address && detail.payload.address.toLowerCase() !== currentAddress.toLowerCase()) throw new Error("Signing wallet does not match the connected profile.");
            const signature = await signWalletMessage(currentAddress, detail.payload.message);
            respond(detail.requestId, { address: currentAddress, signature });
          } else throw new Error("Unsupported wallet request.");
        } catch (e) {
          respond(detail.requestId, undefined, e instanceof Error ? e.message : "Wallet request failed.");
        }
      })();
    };
    window.addEventListener("plank:wallet-request", onRequest);
    return () => window.removeEventListener("plank:wallet-request", onRequest);
  }, [adoptAccount, openConnect, refresh]);

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
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("plank:wallet-state", {
        detail: {
          address,
          chainId,
          status,
          isConnected: status === "connected" && Boolean(address),
        },
      })
    );
  }, [address, chainId, status]);

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
