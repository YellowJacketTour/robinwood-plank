"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { isAddress } from "ethers";
import { useWallet } from "@/lib/wallet-context";

/**
 * Condensed "Check Your Planks" card for the landing page (DESIGN.md:
 * capability stays discoverable without duplicating the full wallet
 * viewer — that lives at NftViewer.tsx / the Marketplank My NFTs tab).
 * Routes to the full Gallery search (owner-address matching already exists
 * there) rather than re-implementing a collection fetch here.
 */
export default function WalletLookupCard() {
  const router = useRouter();
  const { openConnect } = useWallet();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = address.trim();
    if (!isAddress(trimmed)) {
      setError("Enter a valid EVM wallet address.");
      return;
    }
    setError("");
    router.push(`/gallery?q=${encodeURIComponent(trimmed)}`);
  }

  function connectWallet() {
    // Same fix as the nav button: connecting happens where the visitor is.
    // Bouncing them to /market to connect abandoned this card's whole point.
    openConnect();
  }

  return (
    <div className="dense-card fx-in flex h-full flex-col p-4 sm:p-5">
      <h3 className="font-display text-lg text-gold-300 sm:text-xl">Check Your Planks</h3>
      <p className="mt-1.5 text-sm text-cream-muted">
        Connect a wallet or paste any address to see its collection, live rank, and trait rarity.
      </p>

      <form onSubmit={onSubmit} className="mt-4 flex gap-2">
        <label htmlFor="landing-wallet-lookup" className="sr-only">
          Wallet address
        </label>
        <input
          id="landing-wallet-lookup"
          type="text"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setError("");
          }}
          placeholder="0x… wallet address"
          spellCheck={false}
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-wood-950 px-3 text-sm font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300"
        />
        <button
          type="submit"
          className="min-h-11 shrink-0 rounded-lg border border-line-strong bg-gold-500 px-4 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
        >
          View
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-xs font-bold text-red-300">
          {error}
        </p>
      )}

      <div className="my-4 flex items-center gap-2 text-[0.65rem] font-black uppercase tracking-wide text-foreground/45">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        type="button"
        onClick={connectWallet}
        className="min-h-11 w-full rounded-lg border border-line-strong px-4 text-sm font-bold text-gold-300 transition hover:border-gold-400"
      >
        Connect wallet
      </button>

      <p className="mt-4 text-xs text-cream-muted">
        Robinhood Chain · ERC-721 RobinWood collection · works with any public address.
      </p>
    </div>
  );
}
