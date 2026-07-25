"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  getAddress,
  isAddress,
  type Eip1193Provider,
} from "ethers";
import Reveal from "@/components/Reveal";
import {
  fetchNftMetadata,
  ipfsGatewayCandidates,
  type NftAttribute,
  type NftMetadata,
} from "@/lib/ipfs";
import {
  NFT_ABI,
  NFT_CONTRACT_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
} from "@/lib/mint-contract";

type EthereumProvider = Eip1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type OwnedNft = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  metadataError?: string;
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function errorMessage(error: unknown) {
  if (typeof error !== "object" || error === null) return "Something went wrong.";
  const value = error as {
    code?: number | string;
    shortMessage?: string;
    reason?: string;
    message?: string;
  };
  if (value.code === 4001 || value.code === "ACTION_REJECTED") {
    return "Connection cancelled.";
  }
  return (
    value.shortMessage ||
    value.reason ||
    value.message ||
    "Something went wrong."
  );
}

function normalizeAddressInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !isAddress(trimmed)) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function NftImage({
  imageUri,
  alt,
  className,
  priority = false,
}: {
  imageUri: string;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const candidates = useMemo(() => ipfsGatewayCandidates(imageUri), [imageUri]);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [imageUri]);

  if (!imageUri || failed || candidates.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-wood-950/80 text-4xl ${className ?? ""}`}
        aria-hidden="true"
      >
        🪵
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- IPFS multi-gateway fallback needs native onError
    <img
      src={candidates[Math.min(index, candidates.length - 1)]}
      alt={alt}
      className={className}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={() => {
        if (index + 1 < candidates.length) {
          setIndex((value) => value + 1);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function AttributeList({ attributes }: { attributes: NftAttribute[] }) {
  if (!attributes.length) {
    return (
      <p className="text-sm text-foreground/60">No attributes published for this Plank.</p>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attributes.map((attribute, index) => (
        <li
          key={`${attribute.trait_type ?? "trait"}-${index}`}
          className="rounded-lg border border-gold-500/25 bg-black/25 px-3 py-2"
        >
          <p className="text-[0.7rem] font-extrabold uppercase tracking-[0.14em] text-gold-300/80">
            {attribute.trait_type || "Trait"}
          </p>
          <p className="mt-1 break-words text-sm font-black text-foreground">
            {String(attribute.value ?? "—")}
          </p>
        </li>
      ))}
    </ul>
  );
}

function NftDetailModal({
  nft,
  owner,
  onClose,
}: {
  nft: OwnedNft;
  owner: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="wood-frame relative flex max-h-[min(92dvh,920px)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-wood-900 sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gold-500/20 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-gold-300">
              RobinWood Plank
            </p>
            <h3 id={titleId} className="mt-1 truncate font-display text-2xl text-foreground sm:text-3xl">
              {nft.name}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-gold-500/40 text-xl text-gold-300"
            aria-label="Close NFT details"
          >
            ×
          </button>
        </div>

        <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="relative aspect-square w-full bg-wood-950 sm:aspect-auto sm:min-h-[320px]">
            <NftImage
              imageUri={nft.imageUri}
              alt={nft.name}
              priority
              className="h-full w-full object-contain p-3 sm:p-5"
            />
          </div>

          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-foreground/55">Token ID</dt>
                <dd className="mt-1 font-mono font-black">#{nft.tokenId}</dd>
              </div>
              <div>
                <dt className="text-foreground/55">Owner</dt>
                <dd className="mt-1 font-mono font-black">{shortAddress(owner)}</dd>
              </div>
            </dl>

            {nft.description && (
              <p className="text-sm leading-relaxed text-foreground/75">{nft.description}</p>
            )}

            {nft.metadataError && (
              <p className="rounded-lg border border-red-400/30 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                Metadata partially failed to load: {nft.metadataError}
              </p>
            )}

            <div>
              <h4 className="mb-2 text-sm font-extrabold uppercase tracking-[0.16em] text-gold-300">
                Traits
              </h4>
              <AttributeList attributes={nft.attributes} />
            </div>

            <div className="mt-auto flex flex-col gap-2 pt-2 sm:flex-row">
              <a
                href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}/instance/${nft.tokenId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 text-center text-base font-extrabold text-wood-950"
              >
                View on explorer ↗
              </a>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-gold-500/40 px-4 py-3 text-base font-extrabold text-gold-300"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NftViewer() {
  const [inputAddress, setInputAddress] = useState("");
  const [viewedAddress, setViewedAddress] = useState("");
  const [connectedAddress, setConnectedAddress] = useState("");
  const [nfts, setNfts] = useState<OwnedNft[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<OwnedNft | null>(null);
  const requestIdRef = useRef(0);

  const loadCollection = useCallback(async (wallet: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setMessage("");
    setNfts([]);
    setSelected(null);
    setViewedAddress(wallet);

    try {
      const provider = new JsonRpcProvider(ROBINHOOD_RPC_URL, ROBINHOOD_CHAIN_ID, {
        staticNetwork: true,
      });
      const contract = new Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
      const balance = Number(await contract.balanceOf(wallet));

      if (balance === 0) {
        if (requestId === requestIdRef.current) {
          setNfts([]);
          setMessage("No RobinWood Planks found for this wallet.");
          setLoading(false);
        }
        return;
      }

      const tokenIds = await Promise.all(
        Array.from({ length: balance }, (_, index) =>
          contract.tokenOfOwnerByIndex(wallet, index).then((id: bigint) => Number(id)),
        ),
      );

      const sortedIds = [...tokenIds].sort((a, b) => a - b);

      const tokenUris = await Promise.all(
        sortedIds.map((tokenId) =>
          contract.tokenURI(tokenId).then((uri: string) => ({ tokenId, uri })),
        ),
      );

      const BATCH = 8;
      const owned: OwnedNft[] = [];

      for (let offset = 0; offset < tokenUris.length; offset += BATCH) {
        if (requestId !== requestIdRef.current) return;
        const slice = tokenUris.slice(offset, offset + BATCH);
        const batch = await Promise.all(
          slice.map(async ({ tokenId, uri }) => {
            const fallbackName = `RobinWood Plank #${tokenId}`;
            try {
              const metadata: NftMetadata = await fetchNftMetadata(uri);
              return {
                tokenId,
                tokenUri: uri,
                name: metadata.name?.trim() || fallbackName,
                description: metadata.description?.trim() || "",
                imageUri: metadata.image || "",
                attributes: Array.isArray(metadata.attributes) ? metadata.attributes : [],
              } satisfies OwnedNft;
            } catch (error) {
              return {
                tokenId,
                tokenUri: uri,
                name: fallbackName,
                description: "",
                imageUri: "",
                attributes: [],
                metadataError: errorMessage(error),
              } satisfies OwnedNft;
            }
          }),
        );
        owned.push(...batch);
        if (requestId === requestIdRef.current) {
          setNfts([...owned]);
        }
      }

      if (requestId === requestIdRef.current) {
        setMessage(
          owned.length === 1
            ? "1 RobinWood Plank in this wallet."
            : `${owned.length} RobinWood Planks in this wallet.`,
        );
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setMessage(`Unable to load collection. ${errorMessage(error)}`);
        setNfts([]);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("address") || params.get("wallet");
    if (fromQuery && isAddress(fromQuery)) {
      const checksummed = getAddress(fromQuery);
      setInputAddress(checksummed);
      void loadCollection(checksummed);
    }
  }, [loadCollection]);

  useEffect(() => {
    if (!window.ethereum) return;
    const handleAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const next = accounts[0] ? getAddress(accounts[0]) : "";
      setConnectedAddress(next);
    };
    window.ethereum.on?.("accountsChanged", handleAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", handleAccounts);
  }, []);

  async function connectWallet() {
    setMessage("");
    if (!window.ethereum) {
      setMessage(
        "Open this page in Robinhood Wallet or install an EVM-compatible browser wallet.",
      );
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts[0]) {
        setMessage("No wallet account returned.");
        return;
      }
      // Ensure we read checksum form without forcing a chain switch for a view-only flow.
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const next = getAddress(await signer.getAddress());
      setConnectedAddress(next);
      setInputAddress(next);
      await loadCollection(next);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const wallet = normalizeAddressInput(inputAddress);
    if (!wallet) {
      setMessage("Enter a valid EVM wallet address.");
      setNfts([]);
      setViewedAddress("");
      return;
    }
    setInputAddress(wallet);
    void loadCollection(wallet);
  }

  function onCardKeyDown(event: KeyboardEvent<HTMLButtonElement>, nft: OwnedNft) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelected(nft);
    }
  }

  const heading =
    viewedAddress && !loading
      ? `Collection · ${shortAddress(viewedAddress)}`
      : "Collection Viewer";

  return (
    <section id="collection" className="scroll-mt-24 px-4 py-20 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <h2 className="section-title text-center text-4xl text-gold-300 sm:text-5xl">
            Your Planks
          </h2>
          <p className="lede mx-auto mt-3 max-w-2xl text-center text-foreground/70">
            Connect a wallet or paste an address to view every RobinWood NFT it holds.
          </p>
        </Reveal>

        <Reveal delayMs={120}>
          <div className="wood-frame mx-auto mt-10 max-w-3xl rounded-2xl bg-wood-900/95 p-4 sm:p-6">
            <form
              onSubmit={onSubmit}
              className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
            >
              <label htmlFor="nft-viewer-address" className="sr-only">
                Wallet address
              </label>
              <input
                id="nft-viewer-address"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={inputAddress}
                onChange={(event) => setInputAddress(event.target.value)}
                placeholder="0x… wallet address"
                className="min-h-12 min-w-0 flex-1 rounded-lg border-2 border-gold-500/50 bg-wood-950 px-4 py-3 font-mono text-base font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300"
              />
              <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                <button
                  type="submit"
                  disabled={loading}
                  className="min-h-12 rounded-lg bg-gold-500 px-5 py-3 text-base font-extrabold text-wood-950 disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? "Loading…" : "View NFTs"}
                </button>
                <button
                  type="button"
                  onClick={() => void connectWallet()}
                  disabled={loading}
                  className="min-h-12 rounded-lg border border-gold-500/40 px-5 py-3 text-base font-extrabold text-gold-300 disabled:opacity-60"
                >
                  {connectedAddress ? "My Wallet" : "Connect"}
                </button>
              </div>
            </form>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/65">
              <p role="status" aria-live="polite">
                {message || "Robinhood Chain · ERC-721 RobinWood collection"}
              </p>
              <a
                href={`${ROBINHOOD_EXPLORER_URL}/token/${NFT_CONTRACT_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-bold text-gold-300 hover:text-gold-400"
              >
                Contract ↗
              </a>
            </div>
          </div>
        </Reveal>

        <div className="mt-8">
          <div className="mb-4 flex items-end justify-between gap-3">
            <h3 className="font-display text-xl text-gold-300 sm:text-2xl">{heading}</h3>
            {loading && (
              <span className="text-sm font-bold uppercase tracking-wide text-foreground/55">
                Fetching…
              </span>
            )}
          </div>

          {loading && nfts.length === 0 && (
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4"
              aria-hidden="true"
            >
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={index}
                  className="wood-frame animate-pulse overflow-hidden rounded-xl bg-wood-900/80"
                >
                  <div className="aspect-square bg-wood-950/70" />
                  <div className="space-y-2 p-3">
                    <div className="h-4 w-3/4 rounded bg-gold-500/15" />
                    <div className="h-3 w-1/3 rounded bg-gold-500/10" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && nfts.length === 0 && viewedAddress && (
            <div className="wood-frame rounded-2xl bg-wood-900/90 px-5 py-12 text-center">
              <div className="text-4xl" aria-hidden="true">
                🪵
              </div>
              <p className="mt-3 text-lg font-black text-foreground">Empty woodpile</p>
              <p className="mt-2 text-foreground/65">
                This wallet does not hold any RobinWood Planks yet.
              </p>
              <a
                href="#mint"
                className="mt-5 inline-flex min-h-12 items-center justify-center rounded-lg bg-gold-500 px-6 py-3 font-extrabold text-wood-950"
              >
                Mint RobinWood
              </a>
            </div>
          )}

          {nfts.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {nfts.map((nft) => (
                <li key={nft.tokenId}>
                  <button
                    type="button"
                    onClick={() => setSelected(nft)}
                    onKeyDown={(event) => onCardKeyDown(event, nft)}
                    className="wood-frame group flex h-full w-full flex-col overflow-hidden rounded-xl bg-wood-900/95 text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
                    aria-label={`Open details for ${nft.name}`}
                  >
                    <div className="relative aspect-square w-full overflow-hidden bg-wood-950">
                      <NftImage
                        imageUri={nft.imageUri}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3 sm:p-3.5">
                      <p className="line-clamp-2 text-sm font-black leading-snug text-foreground sm:text-base">
                        {nft.name}
                      </p>
                      <p className="font-mono text-xs font-bold text-gold-300 sm:text-sm">
                        #{nft.tokenId}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!viewedAddress && !loading && (
            <p className="mt-6 text-center text-sm text-foreground/55">
              Tip: works with any public address — no transaction required.
            </p>
          )}
        </div>
      </div>

      {selected && viewedAddress && (
        <NftDetailModal
          nft={selected}
          owner={viewedAddress}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
