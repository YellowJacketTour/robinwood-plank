/**
 * Client-side wallet helpers for the cross-chain "Buy from another chain"
 * flow — deliberately separate from lib/wallet.ts.
 *
 * lib/wallet.ts's sendTransaction() is intentionally hard-locked to
 * Robinhood Chain (ensureRobinhoodChain + assertSafeSwapDestination), which
 * is exactly right for the same-chain SwapWidget but wrong here: a
 * cross-chain plan's early steps execute ON THE SOURCE CHAIN (e.g.
 * Arbitrum), not Robinhood Chain. Reusing lib/wallet.ts's sender would
 * either reject every source-chain step, or (worse) silently force a chain
 * switch mid-flow. This file re-implements the minimum needed for a
 * multi-chain plan instead.
 *
 * SECURITY NOTE (residual gap, flag defaults OFF until closed): the
 * same-chain widget pins every swap's tx.to to the one known Universal
 * Router address. A cross-chain plan's bridge-leg step targets Across
 * Protocol's SpokePool contract, which is deployed at a different address
 * per chain — those addresses are not yet enumerated/pinned here. The
 * server (lib/crosschain-server.ts assertPlanStepsSane) restricts every
 * step to known step/method/status shapes and to only the two chains a
 * given plan is allowed to touch (source chain or Robinhood Chain), but it
 * does NOT yet pin exact per-chain bridge contract addresses the way
 * UNIVERSAL_ROUTER_ADDRESS is pinned for same-chain swaps. Close this gap
 * (enumerate Across SpokePool addresses per supported source chain) before
 * enabling NEXT_PUBLIC_CROSSCHAIN_ENABLED in production.
 */
import { getEthereumProvider } from "@/lib/wallet";
import { normalizeChainId } from "@/lib/wallet";

type ChainMeta = {
  chainId: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
};

/** Minimal, well-known public metadata for wallet_addEthereumChain — only
 * used as a fallback when a wallet doesn't already recognize the chain. */
const CHAIN_METADATA: Record<number, ChainMeta> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://cloudflare-eth.com"],
    blockExplorerUrls: ["https://etherscan.io"],
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
  },
  8453: {
    chainId: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
  10: {
    chainId: 10,
    name: "OP Mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.optimism.io"],
    blockExplorerUrls: ["https://optimistic.etherscan.io"],
  },
  137: {
    chainId: 137,
    name: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-rpc.com"],
    blockExplorerUrls: ["https://polygonscan.com"],
  },
};

export async function getWalletChainId(): Promise<number> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const raw = await provider.request({ method: "eth_chainId" });
  return normalizeChainId(raw);
}

/** Switch the wallet to an arbitrary supported chain — NOT Robinhood-only,
 * unlike lib/wallet.ts's switchToRobinhoodChain. */
export async function switchToChain(chainId: number): Promise<void> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const hex = `0x${chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
    return;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902 && code !== -32603 && code !== -32601) {
      const msg = (err as { message?: string })?.message || "Network switch rejected.";
      if (/user rejected|denied|4001/i.test(msg)) {
        throw new Error("Network switch cancelled in wallet.");
      }
      throw new Error(msg);
    }
  }

  const meta = CHAIN_METADATA[chainId];
  if (!meta) {
    throw new Error(`Wallet doesn't recognize chain ${chainId} and no fallback metadata is configured.`);
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: hex,
        chainName: meta.name,
        nativeCurrency: meta.nativeCurrency,
        rpcUrls: meta.rpcUrls,
        blockExplorerUrls: meta.blockExplorerUrls,
      },
    ],
  });
}

export type CrossChainTxPayload = {
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
};

function toHex(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value.startsWith("0x")) return value;
  try {
    const n = BigInt(value);
    return `0x${n.toString(16)}`;
  } catch {
    return undefined;
  }
}

/**
 * Send one cross-chain plan step's transaction. Unlike lib/wallet.ts's
 * sendTransaction, this does NOT force Robinhood Chain and does NOT check
 * against UNIVERSAL_ROUTER_ADDRESS — the caller (CrossChainPanel) is
 * responsible for having already gotten this payload from our own
 * server-validated /api/crosschain/plan response (which pinned the step's
 * chain to source-or-destination and its shape to known step types).
 */
export async function sendCrossChainStepTx(
  chainId: number,
  from: string,
  payload: CrossChainTxPayload
): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");

  const current = await getWalletChainId();
  if (current !== chainId) {
    throw new Error(`Wallet must be on chain ${chainId} for this step — switch and retry.`);
  }

  const tx: Record<string, string> = {
    to: payload.to,
    from,
    data: payload.data,
  };
  const value = toHex(payload.value);
  if (value && value !== "0x0") tx.value = value;
  const gas = toHex(payload.gasLimit) || toHex(payload.gas);
  if (gas) tx.gas = gas;
  const maxFee = toHex(payload.maxFeePerGas);
  const maxPriority = toHex(payload.maxPriorityFeePerGas);
  if (maxFee) tx.maxFeePerGas = maxFee;
  if (maxPriority) tx.maxPriorityFeePerGas = maxPriority;
  if (!maxFee) {
    const gasPrice = toHex(payload.gasPrice);
    if (gasPrice) tx.gasPrice = gasPrice;
  }

  try {
    return (await provider.request({
      method: "eth_sendTransaction",
      params: [tx],
    })) as string;
  } catch (err) {
    const msg = (err as { message?: string; shortMessage?: string })?.shortMessage ||
      (err as { message?: string })?.message ||
      "Transaction rejected.";
    if (/user rejected|denied|4001/i.test(msg)) {
      throw new Error("Transaction cancelled in wallet.");
    }
    throw new Error(msg);
  }
}
