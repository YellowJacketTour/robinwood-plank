"use client";

/** Deterministic research brief grounded in loaded records and collection snapshots. */
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
  if (f.supply != null && f.supply > 0) {
    out.push(`Reported collection supply: ${f.supply.toLocaleString()} pieces.${f.holders != null ? ` ${f.holders.toLocaleString()} unique holders observed (${((f.holders / f.supply) * 100).toFixed(1)}% of supply).` : ""}`);
  }
  out.push(f.listedCount > 0 ? `${f.listedCount.toLocaleString()} distinct pieces appear in the loaded asks.` : "No distinct pieces appear in the loaded asks.");
  if (f.demandGradable && f.demandScore != null) {
    out.push(`Demand score: ${f.demandScore} / 100, combining the available market activity, listings, ownership and catalog signals.`);
  } else {
    out.push("Demand score could not be computed -- insufficient recent trading evidence.");
  }
  if (f.totalTradeCount > 0 && f.washRatio != null) {
    out.push(
      f.washRatio > 0.15
        ? `Wash-trade screening flags ${f.washTradeCount} of ${f.totalTradeCount} observed priced trades (${(f.washRatio * 100).toFixed(1)}%) as reciprocal or self-transfer patterns -- elevated, treat volume figures with caution.`
        : `Wash-trade screening flags ${f.washTradeCount} of ${f.totalTradeCount} loaded priced trades (${(f.washRatio * 100).toFixed(1)}%). These limited patterns cannot establish whether trading is organic.`
    );
  } else {
    out.push("No priced trades are available yet to screen for wash-trading patterns.");
  }
  if (f.makerHhi > 0) {
    out.push(
      `Loaded listing-maker concentration: ${f.makerHhi.toFixed(0)} HHI${f.makerGini != null ? ` (${(f.makerGini * 100).toFixed(1)} Gini)` : ""}. This sample includes only loaded asks with reported makers.`
    );
  }
  if (f.usdVolume > 0) {
    out.push(`$${f.usdVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })} in real, USD-priced volume observed in the loaded evidence window, across ${f.observedTransactions.toLocaleString()} transactions and ${f.walletCount.toLocaleString()} distinct wallets.`);
  } else {
    out.push("No USD-priced sale volume has been observed in the currently loaded evidence window.");
  }
  out.push("This brief describes the loaded evidence and collection snapshots. Partial coverage can change the conclusions as new records arrive.");
  return out;
}

export default function CollectionDossier({ facts }: { facts: DossierFacts }) {
  const sentences = buildSentences(facts);

  return (
    <article className="rounded-xl border border-purple-400/35 bg-[#07050d] p-4 font-mono">
      <p className="mb-3 text-[0.58rem] font-black uppercase tracking-[0.22em] text-purple-300">Research brief · computed from available evidence</p>
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {sentences.map((sentence, index) => (
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
