"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  formatEther,
  type Eip1193Provider,
} from "ethers";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_HEX_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
  SALE_PHASE_NAMES,
} from "@/lib/mint-contract";
import { getMintReadClient } from "@/lib/robinhood-provider";

const TOTAL_SUPPLY = 1542;
const COMMUNITY_SUPPLY = 777;

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
  /** False until at least one successful chain read. */
  live: boolean;
};

const EMPTY_STATS: Stats = {
  phase: -1,
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
  live: false,
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

function phaseLabel(phase: number, live: boolean, loading: boolean) {
  if (loading && !live) return "Loading…";
  if (!live) return "Offline";
  if (phase < 0) return "Unknown";
  return SALE_PHASE_NAMES[phase] || "Unknown";
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
  const [rpcLabel, setRpcLabel] = useState("");

  const loadStats = useCallback(async (walletAddress = address) => {
    try {
      const { contract, rpcUrl } = await getMintReadClient();
      setRpcLabel(rpcUrl.includes("blockscout") ? "Blockscout RPC" : "Robinhood RPC");

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
        live: true,
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

      setMessage((current) =>
        current.startsWith("Unable to read") ? "" : current,
      );
      setLoading(false);
    } catch (error) {
      setMessage(`Unable to read the mint contract. ${errorMessage(error)}`);
      setLoading(false);
      // Keep last good live stats if we had them; otherwise stay offline (not "Closed")
      setStats((previous) =>
        previous.live
          ? previous
          : {
              ...EMPTY_STATS,
              live: false,
            },
      );
    }
  }, [address]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadStats(), 0);
    const timer = window.setInterval(() => void loadStats(), 12_000);
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
    !stats.live
      ? 0
      : stats.phase === 1
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
    if (!stats.live || stats.paused || stats.phase <= 0 || phaseLimit === 0) return;

    setBusy(true);
    setMessage("");
    setTransactionHash("");
    try {
      // Fresh phase check right before mint
      await loadStats(address);
      const signer = await getSigner();
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);

      // Re-read phase from wallet provider path via public client for truth
      const { contract: readContract } = await getMintReadClient();
      const livePhase = Number(await readContract.salePhase());
      if (livePhase !== stats.phase && livePhase > 0) {
        // Stats refresh will update UI; use live phase for this tx
      }
      const phase = livePhase;

      let transaction;
      if (phase === 1) {
        transaction = await contract.freeMint(mintQuantity);
      } else if (phase === 2) {
        const response = await fetch("/proofs.json", { cache: "no-store" });
        if (!response.ok) throw new Error("The Wood List proof file is not available yet.");
        const proofData = (await response.json()) as {
          proofs?: Record<string, string[]>;
          [key: string]: unknown;
        };
        const normalizedAddress = address.toLowerCase();
        const proof =
          proofData.proofs?.[normalizedAddress] ||
          (proofData[normalizedAddress] as string[] | undefined);
        if (!proof) throw new Error("This wallet is not on the Wood List.");
        transaction = await contract.allowlistMint(mintQuantity, proof);
      } else if (phase === 3) {
        const livePrice = (await contract.mintPrice()) as bigint;
        transaction = await contract.publicMint(mintQuantity, {
          value: livePrice * BigInt(mintQuantity),
        });
      } else {
        throw new Error("Minting is currently closed on-chain.");
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

  const soldOut = stats.live && stats.remainingTotal === 0;
  const offline = !stats.live && !loading;
  const trulyClosed = stats.live && stats.phase === 0;

  const buttonLabel = offline
    ? "Retry connection"
    : !address
      ? "Connect Wallet"
      : busy
        ? "Waiting for wallet…"
        : soldOut
          ? "Sold Out"
          : stats.paused
            ? "Mint Paused"
            : trulyClosed
              ? "Mint Closed"
              : !stats.live
                ? "Loading mint…"
                : phaseLimit === 0
                  ? "Mint Limit Reached"
                  : stats.phase === 1
                    ? `Mint ${mintQuantity} Free`
                    : stats.phase === 2
                      ? `Mint ${mintQuantity} Wood List`
                      : stats.phase === 3
                        ? `Mint ${mintQuantity} for ${totalPrice} ETH`
                        : "Mint Unavailable";

  const buttonDisabled =
    loading ||
    busy ||
    (Boolean(address) &&
      stats.live &&
      (stats.paused || soldOut || trulyClosed || phaseLimit === 0));

  return (
    <div className="wood-frame w-full rounded-2xl bg-wood-900/95 p-5 text-left shadow-2xl sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold-500/20 pb-4">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-gold-300">
            Live Robinhood Chain Mint
          </p>
          <p className="mt-1 text-sm text-foreground/60">
            {address ? `Connected: ${shortAddress(address)}` : "Connect an EVM wallet to mint."}
            {rpcLabel ? ` · ${rpcLabel}` : ""}
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

      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-foreground/55">Sale phase</dt>
          <dd className="mt-1 font-bold text-foreground">
            {phaseLabel(stats.phase, stats.live, loading)}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Minted</dt>
          <dd className="mt-1 font-bold text-foreground">
            {stats.live ? `${stats.total} / ${TOTAL_SUPPLY}` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Price</dt>
          <dd className="mt-1 font-bold text-foreground">
            {stats.live ? `${formatEther(stats.priceWei)} ETH` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Community</dt>
          <dd className="mt-1 font-bold text-foreground">
            {stats.live ? `${stats.community} / ${COMMUNITY_SUPPLY}` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Free / Wood List</dt>
          <dd className="mt-1 font-bold text-foreground">
            {stats.live ? `${stats.free} / ${stats.allowlist}` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-foreground/55">Paid minted</dt>
          <dd className="mt-1 font-bold text-foreground">
            {stats.live ? stats.paid : "—"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/35">
        <div
          className="h-full rounded-full bg-gold-500 transition-[width]"
          style={{
            width: stats.live
              ? `${Math.min(100, (stats.total / TOTAL_SUPPLY) * 100)}%`
              : "0%",
          }}
        />
      </div>

      {address && stats.live && stats.phase > 0 && phaseLimit > 0 && (
        <div className="mx-auto mt-5 flex w-fit items-center gap-5 rounded-full border border-gold-500/30 bg-black/20 p-1">
          <button
            type="button"
            aria-label="Decrease mint quantity"
            disabled={busy || mintQuantity <= 1}
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            className="h-12 w-12 rounded-full text-xl font-bold text-gold-300 disabled:opacity-35"
          >
            −
          </button>
          <strong className="min-w-6 text-center text-lg">{mintQuantity}</strong>
          <button
            type="button"
            aria-label="Increase mint quantity"
            disabled={busy || mintQuantity >= phaseLimit}
            onClick={() => setQuantity((value) => Math.min(phaseLimit, value + 1))}
            className="h-12 w-12 rounded-full text-xl font-bold text-gold-300 disabled:opacity-35"
          >
            +
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (offline) {
            setLoading(true);
            void loadStats(address);
            return;
          }
          void submitMint();
        }}
        disabled={buttonDisabled && !offline}
        className="mt-5 min-h-14 w-full rounded-lg bg-gold-500 px-6 py-4 text-base font-extrabold text-wood-950 transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {buttonLabel}
      </button>

      {offline && (
        <p className="mt-3 text-sm text-amber-200/90">
          Chain data is offline (RPC). Mint is not necessarily closed — tap Retry.
        </p>
      )}

      {stats.live && stats.phase === 3 && (
        <p className="mt-3 text-sm text-foreground/65">
          Paid mint is open · 0.01 ETH each · max 33 / wallet
        </p>
      )}

      {stats.communityReleased && (
        <p className="mt-3 text-sm text-foreground/65">
          Community minting is closed. Unused community supply has moved to paid capacity.
        </p>
      )}
      {message && (
        <p className="mt-3 text-sm text-foreground/80" role="status" aria-live="polite">
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
      <p className="mt-3 text-xs text-foreground/45">
        Gas is paid in ETH on Robinhood Chain (ID 4663).
      </p>
    </div>
  );
}
