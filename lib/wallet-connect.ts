/**
 * WalletConnect v2 (QR / mobile) for plank.love.
 * Loads the browser bundle from /wallet-connect-bundle.js (static asset)
 * so Cloudflare Workers stay under free size limits.
 */

import type { Eip1193Provider } from "@/lib/wallet";
import { isRobinhoodChainId, normalizeChainId } from "@/lib/wallet";
import { CHAIN } from "@/lib/constants";

type WcProvider = Eip1193Provider & {
  connect: (opts?: Record<string, unknown>) => Promise<void>;
  enable?: () => Promise<string[]>;
  disconnect?: () => Promise<void>;
  accounts?: string[];
  chainId?: number | string;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type BundleMod = {
  EthereumProvider: {
    init: (opts: Record<string, unknown>) => Promise<WcProvider>;
  };
  QRCode?: {
    toDataURL: (text: string, opts?: Record<string, unknown>) => Promise<string>;
  };
};

let bundlePromise: Promise<BundleMod> | null = null;
let wcProvider: WcProvider | null = null;
let preferredProvider: Eip1193Provider | null = null;
/** Bumped on every new connect / cancel so stale connects abort. */
let connectGeneration = 0;
/**
 * Set by lib/wallet-reown.ts's connect surface when AppKit hands back a
 * relay (WalletConnect) session rather than an injected one. This file's
 * own connectWithWalletConnect() flow never touches this flag — it keeps
 * using the wcProvider identity check below, unchanged. The flag exists so
 * isWalletConnectActive() stays a true "is the active session a relay
 * session" signal regardless of which connector layer produced it, since
 * ensureRobinhoodChain() (lib/wallet.ts) keys its 3s-vs-12s switch timeout
 * off this function and must not silently regress when the Reown path is
 * flagged on.
 */
let externalRelaySessionActive = false;

export function setExternalWalletConnectActive(active: boolean): void {
  externalRelaySessionActive = active;
}

function loadBundle(): Promise<BundleMod> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("WalletConnect only runs in the browser."));
  }
  if (!bundlePromise) {
    const importUrl = `${window.location.origin}/wallet-connect-bundle.js`;
    bundlePromise = new Function("u", "return import(u)")(importUrl) as Promise<BundleMod>;
  }
  return bundlePromise;
}

export function getPreferredWalletProvider(): Eip1193Provider | null {
  return preferredProvider;
}

export function setPreferredWalletProvider(p: Eip1193Provider | null) {
  preferredProvider = p;
}

/** True when the active session is WalletConnect (not a browser extension).
 * Checks this module's own legacy bundle-backed session OR the externally
 * reported Reown/AppKit relay session (see externalRelaySessionActive above). */
export function isWalletConnectActive(): boolean {
  return (
    Boolean(preferredProvider && wcProvider && preferredProvider === wcProvider) ||
    externalRelaySessionActive
  );
}

export function getWalletConnectProjectId(): string {
  return (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "").trim();
}

export async function qrDataUrlForUri(uri: string): Promise<string> {
  try {
    const mod = await loadBundle();
    if (mod.QRCode?.toDataURL) {
      return mod.QRCode.toDataURL(uri, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      });
    }
  } catch {
    /* fall through */
  }
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=12&data=${encodeURIComponent(uri)}`;
}

/**
 * Tear down WC without hanging the UI (Rabby often never resolves disconnect).
 */
export async function disconnectWalletConnect(): Promise<void> {
  connectGeneration += 1;
  const p = wcProvider;
  wcProvider = null;
  preferredProvider = null;
  if (!p?.disconnect) return;
  await Promise.race([
    p.disconnect().catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 1200)),
  ]);
}

/** Cancel any in-flight QR connect (modal close / New QR). */
export function cancelWalletConnectConnect(): void {
  connectGeneration += 1;
  void disconnectWalletConnect();
}

/**
 * Start WalletConnect pairing. Calls onDisplayUri when the QR payload is ready.
 * Session is Robinhood Chain (4663) only — do not add Ethereum mainnet as optional
 * or mobile wallets land on the wrong network and freeze on switch.
 */
export async function connectWithWalletConnect(opts: {
  projectId: string;
  onDisplayUri: (uri: string) => void;
}): Promise<string> {
  const projectId = opts.projectId.trim();
  if (projectId.length < 20) {
    throw new Error("Paste a valid WalletConnect Project ID from cloud.reown.com");
  }
  // Cancel previous attempt first so a second "Show QR" does not freeze.
  await disconnectWalletConnect();
  const gen = ++connectGeneration;

  const { EthereumProvider } = await loadBundle();
  if (gen !== connectGeneration) throw new Error("Connection cancelled.");

  const wc = await EthereumProvider.init({
    projectId,
    // ONLY Robinhood — optional mainnet caused wrong-network + freeze on switch
    chains: [CHAIN.id],
    optionalChains: [CHAIN.id],
    rpcMap: {
      [CHAIN.id]: CHAIN.rpcUrls.default,
    },
    showQrModal: false,
    disableProviderPing: true,
    metadata: {
      name: "plank.love",
      description: "RobinWood Marketplank — Instant Swap & vault",
      url: typeof window !== "undefined" ? window.location.origin : "https://plank.love",
      icons: ["https://plank.love/plank-social.jpg"],
    },
  });

  if (gen !== connectGeneration) {
    try {
      await wc.disconnect?.();
    } catch {
      /* ignore */
    }
    throw new Error("Connection cancelled.");
  }

  wcProvider = wc;

  const onUri = (...args: unknown[]) => {
    if (gen !== connectGeneration) return;
    const uri = args[0];
    if (typeof uri === "string" && uri.length > 0) opts.onDisplayUri(uri);
  };
  wc.on("display_uri", onUri);

  try {
    await wc.connect({ chains: [CHAIN.id] });
  } catch (e1) {
    if (gen !== connectGeneration) throw new Error("Connection cancelled.");
    try {
      if (wc.enable) await wc.enable();
      else throw e1;
    } catch (e2) {
      wcProvider = null;
      preferredProvider = null;
      throw e2 instanceof Error ? e2 : new Error("WalletConnect connect failed.");
    }
  }

  if (gen !== connectGeneration) {
    preferredProvider = null;
    throw new Error("Connection cancelled.");
  }

  let accounts = wc.accounts ?? [];
  if (!accounts.length) {
    accounts = (await wc.request({ method: "eth_requestAccounts" })) as string[];
  }
  if (!accounts?.[0]) throw new Error("No account returned from WalletConnect.");

  preferredProvider = wc;

  // Soft chain check — use normalizeChainId (never parseInt(decimal, 16)).
  // Do not throw here: modal handles need_chain UI. Only attempt a timed switch.
  try {
    const raw = await wc.request({ method: "eth_chainId" });
    const id = normalizeChainId(raw);
    if (!isRobinhoodChainId(id)) {
      await Promise.race([
        wc
          .request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${CHAIN.id.toString(16)}` }],
          })
          .catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 2500)),
      ]);
    }
  } catch {
    // leave connected; ensureRobinhoodChain / modal retry will re-check
  }

  return accounts[0];
}
