"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import { createGameAccountClient } from "@/lib/charmville/account-client";
import HomePermissions from "./home-permissions";

type Account = { wallet: string; handle: string; approved: boolean; profileId?: string };
const noSubscription = () => () => {};
const localBrowser = () => ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

export default function Start() {
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const currentWallet = useRef<string | null | undefined>(undefined);
  const mounted = useRef(true);
  const [gameAccount] = useState(() => createGameAccountClient());
  const invalidate = useCallback(() => { ++generation.current; gameAccount.disconnect(); }, [gameAccount]);
  const local = useSyncExternalStore(noSubscription, localBrowser, () => false);

  const resolve = useCallback(async (wallet: string, token: string, version: number) => {
    const response = await fetch(`/api/auth/session?wallet=${encodeURIComponent(wallet)}`, {
      headers: { authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!response.ok) throw new Error("Your account could not be checked. Please try again.");
    const session = await response.json() as { active?: boolean; handle?: string };
    if (!session.active) throw new Error("Your sign-in expired. Connect and sign in again.");
    const handle = typeof session.handle === "string" ? session.handle : "";
    let approved = false;
    if (handle) {
      const profile = await fetch(`/api/profiles?handle=${encodeURIComponent(handle)}`, { cache: "no-store" });
      if (profile.status !== 404 && !profile.ok) throw new Error("Your profile could not be loaded. Please try again.");
      approved = profile.ok;
    }
    if (!mounted.current || version !== generation.current) return;
    const identity = approved ? await gameAccount.connect(token) : undefined;
    if (identity && identity.handle !== handle) throw new Error("Your account changed. Please sign in again.");
    if (mounted.current && version === generation.current) setAccount({ wallet, handle, approved, profileId: identity?.profileId });
  }, [gameAccount]);

  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    currentWallet.current = undefined;
    const unsubscribe = subscribePlankLoveWalletState(state => {
      if (disposed) return;
      const wallet = state.address?.toLowerCase() ?? null;
      if (wallet === currentWallet.current) return;
      currentWallet.current = wallet;
      gameAccount.disconnect();
      const version = ++generation.current;
      setAccount(null); setError(""); setBusy(false);
      if (!wallet) return;
      void savedWalletProof(wallet).then(proof => {
        if (proof.sessionToken && version === generation.current) return resolve(wallet, proof.sessionToken, version);
      }).catch(reason => {
        if (mounted.current && version === generation.current) setError(reason instanceof Error ? reason.message : "Could not restore your account.");
      });
    });
    return () => { disposed = true; mounted.current = false; invalidate(); unsubscribe(); };
  }, [resolve, invalidate, gameAccount]);

  async function enter() {
    if (busy) return;
    setBusy(true); setError("");
    let version = generation.current;
    try {
      const wallet = await connectPlankLoveWallet();
      if (!mounted.current) return;
      // Connecting may emit the first account event. Signing below is bound
      // to this address, and a later switch invalidates its result.
      if (currentWallet.current && currentWallet.current !== wallet) throw new Error("Your wallet changed. Please try again.");
      currentWallet.current = wallet;
      version = ++generation.current;
      setBusy(true);
      const proof = await walletProof(wallet, "profile:read", wallet, { wallet });
      if (version !== generation.current) return;
      await resolve(wallet, proof.sessionToken, version);
    } catch (reason) {
      if (mounted.current && version === generation.current) setError(reason instanceof Error ? reason.message : "Could not open your homestead.");
    } finally {
      if (mounted.current && version === generation.current) setBusy(false);
    }
  }

  return <main data-market-shell className="relative mx-auto max-w-6xl px-4 pb-20 pt-28 text-cream">
    <header className="mb-8 max-w-3xl">
      <p className="mb-2 text-sm text-gold-300">Charmville · Your first home</p>
      <h1 className="font-display text-4xl">Your place in the world.</h1>
      <p className="mt-4 text-cream-muted">Use your PlankSpace profile to enter Charmville and manage visitor permissions.</p>
    </header>
    {!account ? <section className="mb-6 rounded-xl border border-line bg-panel p-6">
      <h2 className="font-display text-2xl">Enter Charmville</h2>
      <p className="my-3 text-cream-muted">Use the wallet connected to PlankSpace. If this is your first visit, you can create your profile after signing in.</p>
      <button type="button" onClick={enter} disabled={busy} className="min-h-12 rounded-lg bg-gold-500 px-6 py-3 font-bold text-on-gold disabled:opacity-60">{busy ? "Opening your account…" : "Connect and sign in"}</button>
    </section> : !account.handle ? <section className="mb-6 rounded-xl border border-line bg-panel p-6">
      <h2 className="font-display text-2xl">Create your player profile</h2>
      <p className="my-3 text-cream-muted">Your wallet is verified. Create your PlankSpace profile, then enter Charmville.</p>
      <Link href="/create-profile" className="inline-flex min-h-12 items-center rounded-lg bg-gold-500 px-6 text-on-gold">Create your profile</Link>
    </section> : !account.approved ? <section className="mb-6 rounded-xl border border-line bg-panel p-6">
      <h2 className="font-display text-2xl">Your profile is awaiting approval</h2>
      <p className="my-3 text-cream-muted">Your world access opens when your PlankSpace profile is approved.</p>
      <Link href="/profile-editor" className="text-gold-300">Review your profile →</Link>
    </section> : <section aria-label="Your player account" className="mb-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-2xl">Welcome home, @{account.handle}</h2><Link href={`/u/${encodeURIComponent(account.handle)}`} className="text-gold-300">Open your board and stamp a Grain →</Link></div>
      <HomePermissions key={`${account.wallet}:${account.handle}`} handle={account.handle} wallet={account.wallet} />
      <Link href="/charmville/world" className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-gold-500 px-5 text-on-gold">Open shared world</Link>
    </section>}
    {error && <p role="alert" className="mb-6 rounded-lg border border-line bg-panel p-4">{error}</p>}
    {local && <section className="mt-6 rounded-xl border border-line bg-panel-soft p-6">
      <h2 className="font-display text-xl">Try the native adventure workshop</h2>
      <p className="my-3 text-cream-muted">Direct runtime access is available for local testing. Local actions do not yet update the shared account economy.</p>
      <a href="http://localhost:3021/charmville/tutorial/" className="inline-flex min-h-11 items-center text-gold-300">Enter the local adventure →</a>
    </section>}
    <p className="mt-6 text-sm text-cream-muted">The shared adventure world, creature battles and persistent native-game inventory are still being connected. Enter the adventure through the shared world.</p>
  </main>;
}
