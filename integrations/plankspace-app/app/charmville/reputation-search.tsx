"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { REPUTATION_FACES, type ReputationBasis, type ReputationFace, type ReputationMetric } from "@/lib/charmville/reputation";
import { encodePineSearch, parsePineSearch, type PineSearch } from "@/lib/charmville/reputation-query";
import type { PineResult } from "@/lib/charmville/reputation-search";
import { getPlankLoveWalletState, subscribePlankLoveWalletState } from "../plank-love-wallet";
import { emptyCondition, ReputationFilterEditor } from "./reputation-filter";
import styles from "./reputation-search.module.css";

type Result = { items: PineResult[]; matched: number; examined: number; scopeLimited: boolean; resultLimited: boolean };
const initialSearch = (): PineSearch => ({ q: "", face: "stalk", basis: "current", metric: "totals", minimum: "0", direction: "desc", filter: emptyCondition() });
export function ReputationSearch() {
  const [draft, setDraft] = useState<PineSearch>(initialSearch);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [resultLabel, setResultLabel] = useState(""), [shareUrl, setShareUrl] = useState(""), [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const currentWallet = useRef<string | null | undefined>(undefined);
  const search = useCallback(async (query: PineSearch, updateUrl = true) => {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    setLoading(true); setError(""); setResult(null); setCopied(false);
    try {
      const params = encodePineSearch(query);
      const publicUrl = `${window.location.origin}${window.location.pathname}?${params}`;
      if (updateUrl) window.history.replaceState(window.history.state, "", publicUrl);
      setShareUrl(publicUrl);
      const wallet = await getPlankLoveWalletState();
      if (active.signal.aborted) return;
      const token = wallet.address ? localStorage.getItem(`plankspace-session:${wallet.address.toLowerCase()}`) : null;
      const response = await fetch(`/api/charmville/reputation?${params}`, { signal: active.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not search pines.");
      if (!active.signal.aborted) {
        setResult(data); setResultLabel(`${query.face} ${query.metric === "supporters" ? "supporters" : "stamps"}`);
      }
    } catch (failure) {
      if (!active.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not search pines.");
    } finally { if (!active.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("pines")) return;
      try {
        const restored = parsePineSearch(params);
        restored.filter ??= { face: restored.face, basis: restored.basis, metric: restored.metric, op: "gte", value: restored.minimum };
        setDraft(restored); void search(restored, false);
      } catch (failure) { setError(failure instanceof Error ? failure.message : "This shared search is invalid."); }
    };
    restore();
    window.addEventListener("popstate", restore);
    const unsubscribe = subscribePlankLoveWalletState(state => {
      const address = state.address?.toLowerCase() ?? null;
      if (currentWallet.current !== undefined && currentWallet.current !== address) {
        controller.current?.abort(); setResult(null); setLoading(false);
      }
      currentWallet.current = address;
    });
    return () => { controller.current?.abort(); unsubscribe(); window.removeEventListener("popstate", restore); };
  }, [search]);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void search(draft); }
  async function copySearch() {
    try { await navigator.clipboard.writeText(shareUrl); setCopied(true); }
    catch { setError("Copy the search link below or the address in your browser."); }
  }
  return <article className={styles.panel}>
    <h2>Find pines by reputation</h2>
    <p>Discover posts through the charms people have given them. Combine counts with ALL, ANY or NOT to find exactly what you want.</p>
    <form onSubmit={submit} className={styles.form}>
      <label className={styles.query}>Words or author<input value={draft.q} onChange={e => setDraft({ ...draft, q: e.target.value })} maxLength={200} placeholder="Search a pine, name or handle" /></label>
      <div className={styles.query}><ReputationFilterEditor filter={draft.filter ?? emptyCondition()} onChange={filter => setDraft({ ...draft, filter })} /></div>
      <label>Sort by charm<select value={draft.face} onChange={e => setDraft({ ...draft, face: e.target.value as ReputationFace })}>{REPUTATION_FACES.map(face => <option key={face} value={face}>{face[0].toUpperCase() + face.slice(1)}</option>)}</select></label>
      <label>Sort count<select value={draft.metric} onChange={e => setDraft({ ...draft, metric: e.target.value as ReputationMetric })}><option value="totals">Total stamps</option><option value="supporters">Unique supporters</option></select></label>
      <label>Sort history<select value={draft.basis} onChange={e => setDraft({ ...draft, basis: e.target.value as ReputationBasis })}><option value="current">Current</option><option value="lifetime">Lifetime</option></select></label>
      <label>Order<select value={draft.direction} onChange={e => setDraft({ ...draft, direction: e.target.value as "asc" | "desc" })}><option value="desc">Most first</option><option value="asc">Fewest first</option></select></label>
      <button className="page-button" disabled={loading}>{loading ? "Searching…" : "Find pines"}</button>
      <button type="button" className={styles.reset} onClick={() => { setDraft(initialSearch()); setResult(null); setError(""); setShareUrl(""); controller.current?.abort(); setLoading(false); window.history.replaceState(window.history.state, "", window.location.pathname); }}>Reset rules</button>
    </form>
    <p className={styles.note}>Current and lifetime counts are equal while stamps are permanent. Your saved session applies your block list. Shared searches use each visitor’s own permissions.</p>
    {shareUrl && <div className={styles.share}><button type="button" onClick={copySearch}>{copied ? "Copied" : "Copy search link"}</button><a href={shareUrl}>Open this saved search</a></div>}
    {loading && <p role="status">Reading the charm trail…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      <p>{result.matched} matching {result.matched === 1 ? "pine" : "pines"} from {result.examined} searched.{result.scopeLimited && " Search covers the latest 1,000 matching public pines; add words to narrow it."}{result.resultLimited && " Showing the first 100; narrow your search to see more specific results."}</p>
      {!result.items.length && <p>No pines match yet. Try another charm or adjust your rules.</p>}
      <div className={styles.results}>{result.items.map(item => <a key={item.id} href={`/u/${encodeURIComponent(item.handle)}#pine-${item.id}`}>
        <span className={styles.count}>{item.count} {resultLabel}</span>
        <strong>{item.displayName} <span>@{item.handle}</span></strong>
        <p>{item.body || "A media pine"}</p>
        <small>Visit pine →</small>
      </a>)}</div>
    </div>}
  </article>;
}
