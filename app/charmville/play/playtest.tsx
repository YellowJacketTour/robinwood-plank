"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";

import { attachLocalPlaytestWallet } from "@/lib/charmville/local-playtest-client";

type GardenSession = { wallet: string; token: string; handle: string; expiresAt: string; posts: {id:number;body:string}[] };
const storageKey = "charmville-local-playtest";
const subscribeHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export default function LocalPlaytest() {
  const [garden, setGarden] = useState<GardenSession | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = useSyncExternalStore(subscribeHydration, clientReady, serverReady);
  const [error, setError] = useState("");
  const detach = useRef<(() => void) | null>(null);

  const activate = useCallback((session: GardenSession) => {
    localStorage.setItem(`plankspace-session:${session.wallet}`, session.token);
    sessionStorage.setItem(storageKey, JSON.stringify(session));
    detach.current?.();
    detach.current = attachLocalPlaytestWallet(session.wallet);
    setGarden(session);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as GardenSession;
        if (/^0x[a-f0-9]{40}$/.test(saved.wallet) && /^local_demo_[a-f0-9]+$/.test(saved.handle) &&
          typeof saved.token === "string" && Date.parse(saved.expiresAt) > Date.now() && Array.isArray(saved.posts)) {
          void fetch(`/api/auth/session?wallet=${encodeURIComponent(saved.wallet)}`, {headers:{authorization:`Bearer ${saved.token}`}})
            .then(response => response.json()).then(result => {
              if (!cancelled && result.active) activate(saved);
              else if (!cancelled) sessionStorage.removeItem(storageKey);
            }).catch(() => { if (!cancelled) setError("Could not restore your account. Check the local server and reload."); });
        }
      } catch { sessionStorage.removeItem(storageKey); }
    }
    return () => { cancelled = true; detach.current?.(); };
  }, [activate]);
  async function enter() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/charmville/local-playtest", {method:"POST"});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your account could not open.");
      activate(result as GardenSession);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Your account could not open."); }
    finally { setBusy(false); }
  }
  return <main data-market-shell className="relative mx-auto max-w-6xl px-4 pb-20 pt-28 text-cream">
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-sm text-cream-muted">Local player account · saved in this browser tab</p>
        <h1 className="font-display text-3xl">A little land. A world of possibility.</h1></div>
      <Link href="/charmville/frontier" className="inline-flex min-h-11 items-center text-gold-300">Explore the new frontier →</Link>
    </div>
    {garden ? <Link href="/charmville/world?panel=play" className="inline-flex min-h-12 items-center rounded-lg bg-gold-500 px-6 text-on-gold">Enter Charmville</Link> :
      <section className="rounded-xl border border-line bg-panel-strong p-8">
        <h2 className="font-display text-2xl">Enter Charmville</h2>
        <p className="my-4 max-w-xl text-cream-muted">Create a local testing account, then enter the unified adventure.</p>
        <button type="button" onClick={enter} disabled={busy || !ready} className="min-h-12 rounded-lg bg-gold-500 px-6 py-3 font-bold text-on-gold disabled:opacity-60">{busy ? "Opening your account…" : "Start playing"}</button>
      </section>}
    {error && <p role="alert" className="mt-4 text-cream">{error}</p>}
  </main>;
}
