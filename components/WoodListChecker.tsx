"use client";

import { useState, type FormEvent } from "react";
import { isAddress } from "ethers";

type Result = "listed" | "not-listed" | "invalid" | "error" | null;

export default function WoodListChecker() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<Result>(null);
  const [checking, setChecking] = useState(false);

  async function checkAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAddress = address.trim().toLowerCase();

    if (!isAddress(normalizedAddress)) {
      setResult("invalid");
      return;
    }

    setChecking(true);
    setResult(null);
    try {
      const response = await fetch("/proofs.json");
      if (!response.ok) throw new Error("Proof file unavailable");
      const data = (await response.json()) as {
        proofs?: Record<string, string[]>;
        [key: string]: unknown;
      };
      const proof =
        data.proofs?.[normalizedAddress] ||
        (data[normalizedAddress] as string[] | undefined);
      setResult(proof ? "listed" : "not-listed");
    } catch {
      setResult("error");
    } finally {
      setChecking(false);
    }
  }

  return (
    <form onSubmit={checkAddress} className="mt-7 border-t border-gold-500/30 pt-6 text-left">
      <label htmlFor="wood-list-address" className="block font-display text-xl text-gold-300">
        Wood Checker
      </label>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          id="wood-list-address"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setResult(null);
          }}
          placeholder="0x..."
          aria-describedby="wood-list-result"
          className="min-w-0 flex-1 rounded-lg border-2 border-gold-500/50 bg-wood-950 px-4 py-3 font-mono text-base font-bold text-foreground outline-none placeholder:text-foreground/40 focus:border-gold-300"
        />
        <button
          type="submit"
          disabled={checking}
          className="min-h-12 rounded-lg bg-gold-500 px-6 py-3 text-base font-black text-wood-950 disabled:cursor-wait disabled:opacity-60"
        >
          {checking ? "Checking..." : "Check Address"}
        </button>
      </div>
      <p
        id="wood-list-result"
        role="status"
        aria-live="polite"
        className={`mt-4 min-h-7 text-lg font-black ${
          result === "listed"
            ? "text-emerald-300"
            : result === "not-listed" || result === "invalid" || result === "error"
              ? "text-red-300"
              : "text-foreground"
        }`}
      >
        {result === "listed" && (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-base text-white"
            >
              ✓
            </span>
            <span>Wood you mint? You wood.</span>
          </span>
        )}
        {result === "not-listed" && (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500 text-base text-white"
            >
              ✕
            </span>
            <span>Wood you mint? You woodn’t.</span>
          </span>
        )}
        {result === "invalid" && "Enter a valid EVM address."}
        {result === "error" && "Could not check the Wood List. Try again."}
      </p>
    </form>
  );
}
