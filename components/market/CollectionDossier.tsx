"use client";

/**
 * "Case file" narrative reveal -- the research brief this was commissioned
 * from (docs/marketplank/ONESHOT-hud-intelligence-research-2026-08-23.md)
 * proposed an LLM-generated dossier with hard grounding rules against
 * hallucination. NO LLM PROVIDER IS CONFIGURED IN THIS APP (checked live
 * 2026-08-23: no OPENAI_API_KEY/ANTHROPIC_API_KEY/any LLM key anywhere in
 * this repo or its env) -- silently standing one up would mean a new
 * billing relationship, a new secret, and a new prompt-injection surface
 * the owner never asked for.
 *
 * This ships the REAL, buildable-today version instead: a deterministic
 * template narrative, where every single clause is generated directly
 * from a real computed number already passed in as a prop (never an LLM
 * completion, so hallucination is structurally impossible) -- typewriter-
 * revealed via `motion` sentence-by-sentence, matching the brief's own
 * "case file reveal" request. If a real LLM key is ever configured, this
 * component's `sentences` array is the exact seam to swap in a real
 * grounded-RAG completion instead of the template -- the reveal
 * choreography below doesn't need to change either way.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

export type DossierFacts = {
  name: string;
  chain: string;
  supply: number | null;
  holders: number | null;
  listedCount: number;
  demandScore: number | null;
  demandGradable: boolean;
  washRatio: number | null;
  washTradeCount: number;
  totalTradeCount: number;
  makerHhi: number;
  makerGini: number | null;
  usdVolume: number;
  observedTransactions: number;
  walletCount: number;
};

function buildSentences(f: DossierFacts): string[] {
  const out: string[] = [];
  out.push(`CASE FILE -- ${f.name.toUpperCase()} · ${f.chain.toUpperCase()}`);
  if (f.supply != null) {
    out.push(`Real minted supply: ${f.supply.toLocaleString()} pieces.${f.holders != null ? ` ${f.holders.toLocaleString()} unique holders observed (${((f.holders / f.supply) * 100).toFixed(1)}% of supply).` : ""}`);
  }
  out.push(f.listedCount > 0 ? `${f.listedCount.toLocaleString()} pieces are currently listed for sale.` : "No pieces are currently listed for sale.");
  if (f.demandGradable && f.demandScore != null) {
    out.push(`Demand score: ${f.demandScore} / 100, computed from real recency-weighted trading momentum.`);
  } else {
    out.push("Demand score could not be computed -- insufficient recent trading evidence.");
  }
  if (f.totalTradeCount > 0 && f.washRatio != null) {
    out.push(
      f.washRatio > 0.15
        ? `Wash-trade screening flags ${f.washTradeCount} of ${f.totalTradeCount} observed priced trades (${(f.washRatio * 100).toFixed(1)}%) as reciprocal or self-transfer patterns -- elevated, treat volume figures with caution.`
        : `Wash-trade screening flags ${f.washTradeCount} of ${f.totalTradeCount} observed priced trades (${(f.washRatio * 100).toFixed(1)}%) -- within a normal range for organic trading.`
    );
  } else {
    out.push("No priced trades are available yet to screen for wash-trading patterns.");
  }
  if (f.makerHhi > 0) {
    out.push(
      `Listing-maker concentration: ${f.makerHhi.toFixed(0)} HHI${f.makerGini != null ? ` (${(f.makerGini * 100).toFixed(1)} Gini)` : ""} -- ${f.makerHhi > 2500 ? "a small number of wallets control a large share of the live order book." : "the live order book is reasonably distributed across makers."}`
    );
  }
  if (f.usdVolume > 0) {
    out.push(`$${f.usdVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })} in real, USD-priced volume observed in the loaded evidence window, across ${f.observedTransactions.toLocaleString()} transactions and ${f.walletCount.toLocaleString()} distinct wallets.`);
  } else {
    out.push("No USD-priced sale volume has been observed in the currently loaded evidence window.");
  }
  out.push("Every figure above is sourced from indexed on-chain evidence. Nothing here is investment advice.");
  return out;
}

export default function CollectionDossier({ facts }: { facts: DossierFacts }) {
  const sentences = buildSentences(facts);
  const [revealed, setRevealed] = useState(1);

  useEffect(() => {
    setRevealed(1);
    if (sentences.length <= 1) return;
    const id = setInterval(() => {
      setRevealed((n) => Math.min(sentences.length, n + 1));
    }, 550);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs the reveal whenever the underlying fact set changes (new collection, new scoped window)
  }, [facts.name, facts.observedTransactions, facts.usdVolume]);

  return (
    <article className="rounded-xl border border-purple-400/35 bg-[#07050d] p-4 font-mono">
      <p className="mb-3 text-[0.58rem] font-black uppercase tracking-[0.22em] text-purple-300">Dossier · deterministic, fully grounded, no LLM configured</p>
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {sentences.slice(0, revealed).map((sentence, index) => (
            <motion.p
              key={sentence}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.35 }}
              className={index === 0 ? "text-sm font-bold tracking-wide text-gold-300" : "text-xs leading-relaxed text-foreground/75"}
            >
              {index === 0 ? sentence : `> ${sentence}`}
            </motion.p>
          ))}
        </AnimatePresence>
      </div>
    </article>
  );
}
