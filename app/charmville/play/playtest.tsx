"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import Porch from "@/integrations/plankspace-app/app/charmville/porch";
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
  const stamps = useCallback(() => {}, []);
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
            }).catch(() => { if (!cancelled) setError("Could not restore your garden. Check the local server and reload."); });
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
      if (!response.ok) throw new Error(result.error || "Your garden could not open.");
      activate(result as GardenSession);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Your garden could not open."); }
    finally { setBusy(false); }
  }
  return <main data-market-shell className="relative mx-auto max-w-6xl px-4 pb-20 pt-28 text-cream">
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-sm text-cream-muted">Local play garden · saved in this browser tab</p>
        <h1 className="font-display text-3xl">A little land. A world of possibility.</h1></div>
      <Link href="/charmville/frontier" className="inline-flex min-h-11 items-center text-gold-300">Explore the new frontier →</Link>
    </div>
    {garden ? <Porch handle={garden.handle} posts={garden.posts} onStamps={stamps} /> :
      <section className="rounded-xl border border-line bg-panel-strong p-8">
        <h2 className="font-display text-2xl">Your first garden is waiting</h2>
        <p className="my-4 max-w-xl text-cream-muted">Gather your first harvest, return its seed to the soil, and collect charms in your satchel. This local sandbox has its own garden and inventory.</p>
        <button type="button" onClick={enter} disabled={busy || !ready} className="min-h-12 rounded-lg bg-gold-500 px-6 py-3 font-bold text-on-gold disabled:opacity-60">{busy ? "Opening your garden…" : "Start playing"}</button>
      </section>}
    {error && <p role="alert" className="mt-4 text-cream">{error}</p>}
  </main>;
}
