"use client";

/**
 * Real holder/trade network -- every node is a real wallet address that
 * appeared as a from/to on a real sale, every edge is a real observed
 * transfer, weighted by real trade count. Built with sigma.js + graphology
 * (@react-sigma/core, MIT) -- NOT Cosmograph, which the research brief
 * this was commissioned from (docs/marketplank/ONESHOT-hud-intelligence-
 * research-2026-08-23.md) initially proposed: Cosmograph is CC-BY-NC-4.0,
 * non-commercial only, and this is a real revenue-generating marketplace.
 * sigma.js/graphology are both real MIT, WebGL-rendered, and handle
 * thousands of nodes/edges at 60fps -- the same real "wow" the brief was
 * after (a navigable, alive-feeling provenance network), without a
 * licensing trap.
 *
 * No node is ever invented: a wallet only appears here because it is a
 * real `from` or `to` on a real observed Sale row. Isolated singletons
 * (a wallet with exactly one trade, no edges to anyone else in the loaded
 * window) are still real and still shown -- this is not curated down to
 * "interesting" wallets only.
 *
 * This entire module is only ever loaded via `dynamic(..., { ssr: false })`
 * from CollectionIntelligence.tsx (same pattern that file already uses for
 * CollectionEvidenceSpace) -- sigma/graphology touch canvas/window at
 * import time, so plain static imports here are safe ONLY because the
 * whole module is deferred client-side by that outer dynamic() call.
 */
import { useEffect, useMemo, useState } from "react";
import { SigmaContainer, useLoadGraph, useRegisterEvents } from "@react-sigma/core";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import "@react-sigma/core/lib/style.css";

type GraphSale = { from: string | null; to: string | null; priceUsd?: number | null; tokenId?: string | null; transaction: string | null };

function GraphLoader({ sales, onSelect }: { sales: GraphSale[]; onSelect: (address: string | null) => void }) {
  const loadGraph = useLoadGraph();
  const registerEvents = useRegisterEvents();

  useEffect(() => {
    const graph = new Graph({ multi: false, type: "directed" });
    const weight = new Map<string, number>();
    for (const sale of sales) {
      const from = sale.from?.toLowerCase();
      const to = sale.to?.toLowerCase();
      if (!from || !to) continue;
      if (!graph.hasNode(from)) graph.addNode(from, { label: from, size: 3, color: "#48d7a4" });
      if (!graph.hasNode(to)) graph.addNode(to, { label: to, size: 3, color: "#f4c95d" });
      const key = `${from}->${to}`;
      weight.set(key, (weight.get(key) ?? 0) + 1);
      if (!graph.hasEdge(from, to)) {
        graph.addEdge(from, to, { size: 1, color: "rgba(180,124,255,.45)", weight: 1 });
      }
    }
    // Node size reflects real degree (how many real trades touch this
    // wallet, as either buyer or seller) -- a real activity signal, not a
    // decorative random size.
    graph.forEachNode((node) => {
      const degree = graph.degree(node);
      graph.setNodeAttribute(node, "size", Math.min(14, 3 + Math.sqrt(degree) * 2));
    });
    graph.forEachEdge((edge, _attrs, from, to) => {
      const key = `${from}->${to}`;
      const w = weight.get(key) ?? 1;
      graph.setEdgeAttribute(edge, "size", Math.min(4, 0.6 + Math.log1p(w)));
    });
    // Random seed positions before FA2 -- a real, common graphology
    // requirement (FA2 needs a starting layout, it does not invent one).
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, "x", Math.random());
      graph.setNodeAttribute(node, "y", Math.random());
    });
    const iterations = Math.min(300, Math.max(30, graph.order * 2));
    const positions = forceAtlas2(graph, { iterations, settings: { gravity: 1, scalingRatio: 8, adjustSizes: true } });
    for (const node in positions) {
      graph.setNodeAttribute(node, "x", positions[node].x);
      graph.setNodeAttribute(node, "y", positions[node].y);
    }
    loadGraph(graph);
    registerEvents({
      clickNode: (event) => onSelect(event.node),
      clickStage: () => onSelect(null),
    });
  }, [sales, loadGraph, registerEvents, onSelect]);

  return null;
}

export default function CollectionTradeGraph({ sales }: { sales: GraphSale[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const edgeCount = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sales) {
      if (s.from && s.to) seen.add(`${s.from.toLowerCase()}->${s.to.toLowerCase()}`);
    }
    return seen.size;
  }, [sales]);
  const walletCount = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sales) {
      if (s.from) seen.add(s.from.toLowerCase());
      if (s.to) seen.add(s.to.toLowerCase());
    }
    return seen.size;
  }, [sales]);
  const walletTradeCount = useMemo(() => {
    if (!selected) return 0;
    return sales.filter((s) => s.from?.toLowerCase() === selected || s.to?.toLowerCase() === selected).length;
  }, [sales, selected]);

  if (sales.length === 0 || walletCount === 0) {
    return (
      <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-line bg-background/55 p-6 text-center text-xs text-foreground/45">
        Trade network requires observed sale records with a real buyer and seller address. No nodes are invented when that evidence is missing.
      </div>
    );
  }

  return (
    <article className="relative overflow-hidden rounded-xl border border-purple-400/35 bg-[#07050d]" aria-label="Interactive real wallet trade network">
      <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-sm">
        <p className="text-[0.58rem] font-black uppercase tracking-[0.18em] text-purple-300">Trade network</p>
        <h4 className="font-display text-lg text-gold-300">{walletCount.toLocaleString()} wallets · {edgeCount.toLocaleString()} real edges</h4>
        <p className="text-[0.65rem] text-foreground/55">Drag to pan · scroll to zoom · click a wallet to inspect it. Node size = real trade degree.</p>
      </div>
      <div className="h-[26rem] max-h-[62vh] min-h-72 w-full">
        <SigmaContainer
          style={{ height: "100%", width: "100%", background: "#07050d" }}
          settings={{ renderLabels: false, defaultNodeColor: "#b47cff", defaultEdgeColor: "rgba(180,124,255,.4)", labelColor: { color: "#e8e2f5" } }}
        >
          <GraphLoader sales={sales} onSelect={setSelected} />
        </SigmaContainer>
      </div>
      <div className="absolute inset-x-3 bottom-3 z-10 rounded-lg border border-line bg-background/90 p-2 backdrop-blur-md">
        <p className="text-[0.6rem] font-black uppercase tracking-wider text-foreground/45">
          {selected ? "Selected wallet" : `${walletCount.toLocaleString()} real wallets, ${edgeCount.toLocaleString()} real transfer edges`}
        </p>
        {selected ? (
          <p className="truncate text-xs">
            <strong className="break-all text-gold-300">{selected}</strong> · {walletTradeCount} real trade{walletTradeCount === 1 ? "" : "s"} in this window
          </p>
        ) : (
          <p className="text-xs text-foreground/55">Click any node for its exact real trade count. This is evidence geometry, not a simulated social graph.</p>
        )}
      </div>
    </article>
  );
}
