"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  formatEther,
  type Eip1193Provider,
} from "ethers";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_HEX_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
} from "@/lib/mint-contract";

const TOTAL_SUPPLY = 1542;
const COMMUNITY_SUPPLY = 777;
const PHASE_NAMES = ["Closed", "Free Mint", "Allowlist Mint", "Paid Mint"];

type EthereumProvider = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type Stats = {
  phase: number;
  paused: boolean;
  total: number;
  community: number;
  free: number;
  allowlist: number;
  paid: number;
  remainingCommunity: number;
  remainingTotal: number;
  remainingPaidSupply: number;
  priceWei: bigint;
  communityReleased: boolean;
};

const EMPTY_STATS: Stats = {
  phase: 0,
  paused: false,
  total: 0,
  community: 0,
  free: 0,
  allowlist: 0,
  paid: 0,
  remainingCommunity: COMMUNITY_SUPPLY,
  remainingTotal: TOTAL_SUPPLY,
  remainingPaidSupply: 765,
  priceWei: BigInt(0),
  communityReleased: false,
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function errorMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "Transaction failed.";
  const value = error as {
    code?: number | string;
    shortMessage?: string;
    reason?: string;
    message?: string;
    info?: { error?: { message?: string } };
  };
  if (value.code === 4001 || value.code === "ACTION_REJECTED") return "Transaction cancelled.";
  return (
    value.shortMessage ||
    value.reason ||
    value.info?.error?.message ||
    value.message ||
    "Transaction failed."
  );
}

export default function MintPanel() {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [address, setAddress] = useState("");
  const [walletLimits, setWalletLimits] = useState({ free: 2, allowlist: 2, paid: 33 });
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [transactionHash, setTransactionHash] = useState("");

  const loadStats = useCallback(async (walletAddress = address) => {
    try {
      const provider = new JsonRpcProvider(ROBINHOOD_RPC_URL, ROBINHOOD_CHAIN_ID, {
        staticNetwork: true,
      });
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
      const [
        phase,
        paused,
        total,
        community,
        free,
        allowlist,
        paid,
        remainingCommunity,
        remainingTotal,
        remainingPaidSupply,
        priceWei,
        communityReleased,
      ] = await Promise.all([
        contract.salePhase(),
        contract.paused(),
        contract.totalSupply(),
        contract.communityMintsClaimed(),
        contract.freeMintsClaimed(),
        contract.allowlistMintsClaimed(),
        contract.paidMintsClaimed(),
        contract.remainingCommunitySupply(),
        contract.remainingTotalSupply(),
        contract.remainingNonCommunitySupply(),
        contract.mintPrice(),
        contract.communitySupplyReleased(),
      ]);

      setStats({
        phase: Number(phase),
        paused: Boolean(paused),
        total: Number(total),
        community: Number(community),
        free: Number(free),
        allowlist: Number(allowlist),
        paid: Number(paid),
        remainingCommunity: Number(remainingCommunity),
        remainingTotal: Number(remainingTotal),
        remainingPaidSupply: Number(remainingPaidSupply),
        priceWei,
        communityReleased: Boolean(communityReleased),
      });

      if (walletAddress) {
        const [freeRemaining, allowlistRemaining, paidRemaining] = await Promise.all([
          contract.remainingFreeMintsForWallet(walletAddress),
          contract.remainingAllowlistMintsForWallet(walletAddress),
          contract.remainingPaidMintsForWallet(walletAddress),
        ]);
        setWalletLimits({
          free: Number(freeRemaining),
          allowlist: Number(allowlistRemaining),
          paid: Number(paidRemaining),
        });
      }
      setLoading(false);
    } catch (error) {
      setMessage(`Unable to read the mint contract. ${errorMessage(error)}`);
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadStats(), 0);
    const timer = window.setInterval(() => void loadStats(), 15000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [loadStats]);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const nextAddress = accounts[0] || "";
      setAddress(nextAddress);
      if (nextAddress) void loadStats(nextAddress);
    };
    window.ethereum.on?.("accountsChanged", handleAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", handleAccounts);
  }, [loadStats]);

  const phaseLimit =
    stats.phase === 1
      ? Math.min(walletLimits.free, stats.remainingCommunity, stats.remainingTotal)
      : stats.phase === 2
        ? Math.min(walletLimits.allowlist, stats.remainingCommunity, stats.remainingTotal)
        : stats.phase === 3
          ? Math.min(walletLimits.paid, stats.remainingPaidSupply, stats.remainingTotal, 33)
          : 0;

  const mintQuantity = Math.max(1, Math.min(quantity, phaseLimit || 1));

  const totalPrice = useMemo(
    () => formatEther(stats.priceWei * BigInt(mintQuantity)),
    [mintQuantity, stats.priceWei],
  );

  async function connectWallet() {
    setMessage("");
    if (!window.ethereum) {
      setMessage("Open this page in Robinhood Wallet or install an EVM-compatible browser wallet.");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const nextAddress = accounts[0] || "";
      setAddress(nextAddress);
      if (nextAddress) await loadStats(nextAddress);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function getSigner() {
    if (!window.ethereum) throw new Error("No browser wallet found.");
    const currentChain = (await window.ethereum.request({ method: "eth_chainId" })) as string;
    if (currentChain.toLowerCase() !== ROBINHOOD_CHAIN_HEX_ID) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ROBINHOOD_CHAIN_HEX_ID }],
        });
      } catch (switchError) {
        const code = (switchError as { code?: number }).code;
        if (code !== 4902) throw switchError;
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ROBINHOOD_CHAIN_HEX_ID,
              chainName: "Robinhood Chain",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [ROBINHOOD_RPC_URL],
              blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
            },
          ],
        });
      }
    }
    return new BrowserProvider(window.ethereum).getSigner();
  }

  async function submitMint() {
    if (!address) {
      await connectWallet();
      return;
    }
    if (stats.paused || phaseLimit === 0) return;

    setBusy(true);
    setMessage("");
    setTransactionHash("");
    try {
      const signer = await getSigner();
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);
      let transaction;

      if (stats.phase === 1) {
        transaction = await contract.freeMint(mintQuantity);
      } else if (stats.phase === 2) {
        const response = await fetch("/proofs.json", { cache: "no-store" });
        if (!response.ok) throw new Error("The allowlist proof file is not available yet.");
        const proofData = (await response.json()) as {
          proofs?: Record<string, string[]>;
          [key: string]: unknown;
        };
        const normalizedAddress = address.toLowerCase();
        const proof =
          proofData.proofs?.[normalizedAddress] ||
          (proofData[normalizedAddress] as string[] | undefined);
        if (!proof) throw new Error("This wallet is not on the allowlist.");
        transaction = await contract.allowlistMint(mintQuantity, proof);
      } else if (stats.phase === 3) {
        const livePrice = (await contract.mintPrice()) as bigint;
        transaction = await contract.publicMint(mintQuantity, {
          value: livePrice * BigInt(mintQuantity),
        });
      } else {
        throw new Error("Minting is currently closed.");
      }

      setTransactionHash(transaction.hash);
      setMessage("Transaction submitted. Waiting for confirmation…");
      await transaction.wait();
      setMessage(`${mintQuantity} RobinWood Plank${mintQuantity === 1 ? "" : "s"} minted.`);
      await loadStats(address);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const soldOut = stats.remainingTotal === 0;
  const buttonLabel = !address
    ? "Connect Wallet"
    : busy
      ? "Waiting for wallet…"
      : soldOut
        ? "Sold Out"
        : stats.paused
          ? "Mint Paused"
          : stats.phase === 0
            ? "Mint Closed"
            : phaseLimit === 0
              ? "Mint Limit Reached"
              : stats.phase === 1
                ? `Mint ${mintQuantity} Free`
                : stats.phase === 2
                  ? `Mint ${mintQuantity} Allowlist`
                  : `Mint ${mintQuantity} for ${totalPrice} ETH`;

  return (
    <div className="wood-frame w-full rounded-2xl bg-wood-900/95 p-5 text-left shadow-2xl sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold-500/20 pb-5">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-gold-300">
            Live Robinhood Chain Mint
          </p>
          <p className="mt-1 text-sm text-foreground/60">
            {address ? `Connected: ${shortAddress(address)}` : "Connect an EVM wallet to mint."}
          </p>
        </div>
        <a
          href={`${ROBINHOOD_EXPLORER_URL}/address/${NFT_CONTRACT_ADDRESS}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-bold text-gold-300 hover:text-gold-400"
        >
          View contract ↗
        </a>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-foreground/55">Sale phase</dt>
          <dd className="mt-1 font-bold text-foreground">
            {loading ? "Loading…" : PHASE_NAMES[stats.phase] || "Unknown"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Minted</dt>
          <dd className="mt-1 font-bold text-foreground">{stats.total} / {TOTAL_SUPPLY}</dd>
        </div>
        <div>
          <dt className="text-foreground/55">Price</dt>
          <dd className="mt-1 font-bold text-foreground">{formatEther(stats.priceWei)} ETH</dd>
        </div>
        <div>
          <dt className="text-foreground/55">Community</dt>
          <dd className="mt-1 font-bold text-foreground">{stats.community} / {COMMUNITY_SUPPLY}</dd>
        </div>
        <div>
          <dt className="text-foreground/55">Free / allowlist</dt>
          <dd className="mt-1 font-bold text-foreground">{stats.free} / {stats.allowlist}</dd>
        </div>
        <div>
          <dt className="text-foreground/55">Paid minted</dt>
          <dd className="mt-1 font-bold text-foreground">{stats.paid}</dd>
        </div>
      </dl>

      <div className="mt-5 h-2 overflow-hidden rounded-full bg-black/35">
        <div
          className="h-full rounded-full bg-gold-500 transition-[width]"
          style={{ width: `${Math.min(100, (stats.total / TOTAL_SUPPLY) * 100)}%` }}
        />
      </div>

      {address && stats.phase > 0 && phaseLimit > 0 && (
        <div className="mx-auto mt-6 flex w-fit items-center gap-5 rounded-full border border-gold-500/30 bg-black/20 p-1">
          <button
            type="button"
            aria-label="Decrease mint quantity"
            disabled={busy || mintQuantity <= 1}
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            className="h-10 w-10 rounded-full text-xl font-bold text-gold-300 disabled:opacity-35"
          >
            −
          </button>
          <strong className="min-w-6 text-center text-lg">{mintQuantity}</strong>
          <button
            type="button"
            aria-label="Increase mint quantity"
            disabled={busy || mintQuantity >= phaseLimit}
            onClick={() => setQuantity((value) => Math.min(phaseLimit, value + 1))}
            className="h-10 w-10 rounded-full text-xl font-bold text-gold-300 disabled:opacity-35"
          >
            +
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => void submitMint()}
        disabled={loading || busy || (Boolean(address) && (stats.paused || soldOut || stats.phase === 0 || phaseLimit === 0))}
        className="mt-6 w-full rounded-lg bg-gold-500 px-6 py-4 text-base font-extrabold text-wood-950 transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {buttonLabel}
      </button>

      {stats.communityReleased && (
        <p className="mt-4 text-sm text-foreground/65">
          Community minting is closed. Unused community supply has moved to paid capacity.
        </p>
      )}
      {message && (
        <p className="mt-4 text-sm text-foreground/80" role="status" aria-live="polite">
          {message}
        </p>
      )}
      {transactionHash && (
        <a
          href={`${ROBINHOOD_EXPLORER_URL}/tx/${transactionHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm font-bold text-gold-300 hover:text-gold-400"
        >
          View transaction ↗
        </a>
      )}
      <p className="mt-4 text-xs text-foreground/45">
        Free mints still require ETH for Robinhood Chain network fees.
      </p>
    </div>
  );
}
