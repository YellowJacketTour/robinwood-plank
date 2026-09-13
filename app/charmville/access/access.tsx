"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import "../world/world-shell.css";
import styles from "./access.module.css";

type Session = { wallet: string; token: string };
type Grant = { admitted: true; profileId: string; expiresAt: string; alreadyRedeemed: boolean };

function isGrant(value: unknown): value is Grant {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.admitted === true && typeof result.profileId === "string" && /^[1-9]\d{0,17}$/.test(result.profileId) &&
    typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt)) && typeof result.alreadyRedeemed === "boolean";
}

export default function Access() {
  const [session, setSession] = useState<Session | null>(null);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [grant, setGrant] = useState<Grant | null>(null);
  const currentWallet = useRef<string | null>(null);
  const generation = useRef(0);
  const working = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    const epochs = generation;
    mounted.current = true;
    const stop = subscribePlankLoveWalletState(state => {
      const address = state.address?.toLowerCase() ?? null;
      if (address === currentWallet.current) return;
      currentWallet.current = address;
      const version = ++generation.current;
      setSession(null); setGrant(null); setMessage("");
      // A saved session can be checked silently. Creating one always needs a click.
      if (address && !working.current) void savedWalletProof(address).then(proof => {
        if (mounted.current && version === generation.current && proof.sessionToken) setSession({ wallet: address, token: proof.sessionToken });
      }).catch(() => { if (mounted.current && version === generation.current) setMessage("Please sign in again to check your invitation."); });
    });
    return () => { mounted.current = false; ++epochs.current; stop(); };
  }, []);

  async function signIn() {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage("");
    try {
      const address = (await connectPlankLoveWallet()).toLowerCase();
      if (!mounted.current) return;
      if (currentWallet.current && currentWallet.current !== address) throw new Error("Your wallet changed. Please try signing in again.");
      currentWallet.current = address;
      const version = ++generation.current;
      const proof = await walletProof(address, "profile:read", address, { wallet: address });
      if (mounted.current && version === generation.current) setSession({ wallet: address, token: proof.sessionToken });
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "Sign-in could not finish."); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  async function accept() {
    if (working.current || !session || !/^[a-f0-9]{64}$/i.test(invite.trim())) return;
    if (currentWallet.current !== session.wallet) { setMessage("Your account changed. Please sign in again."); return; }
    working.current = true; setBusy(true); setMessage("");
    const version = generation.current;
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 20_000);
    try {
      const response = await fetch("/api/charmville/invites/redeem", {
        method: "POST", headers: { authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.trim().toLowerCase() }), mode: "same-origin", redirect: "error", signal: abort.signal,
      });
      const result = await response.json();
      if (response.status === 401 && mounted.current && version === generation.current) setSession(null);
      if (!response.ok) throw new Error(result.error || "This invitation could not be accepted.");
      if (!isGrant(result)) throw new Error("Access could not be confirmed. Retry the same invitation.");
      if (mounted.current && version === generation.current) { setGrant(result); setInvite(""); }
    } catch (error) {
      if (mounted.current && version === generation.current) setMessage(abort.signal.aborted ? "The response took too long. Retry this invitation to check your access." : error instanceof Error ? error.message : "Please retry this invitation.");
    } finally { window.clearTimeout(timeout); working.current = false; if (mounted.current) setBusy(false); }
  }

  return <main className={`charm-world ${styles.page}`} data-market-shell>
    <section className={styles.card} aria-labelledby="invite-heading" aria-busy={busy}>
      <p className={styles.eyebrow}>Charmville · Private playtest</p>
      <h1 id="invite-heading">An invitation to adventure</h1>
      <p>A place for your home, your companions, and the friends you bring along.</p>
      {grant ? <div className={styles.paper}><h2>You’re on the guest list.</h2>
        <p>{grant.alreadyRedeemed ? "This invitation already belongs to your account." : "Your invitation is now attached to your PlankSpace account."}</p>
        <p>Access until <time dateTime={grant.expiresAt}>{new Date(grant.expiresAt).toLocaleString()}</time>.</p>
        <Link className={styles.primary} href="/charmville/world?panel=play">Enter Charmville</Link>
      </div> : <>
        <div className={styles.paper}><h2>1. Your PlankSpace account</h2>
          {session ? <p>Signed in as {session.wallet.slice(0, 6)}…{session.wallet.slice(-4)}. Your invitation will belong to this account.</p> : <><p>Use the same account you use on PlankSpace.</p>
            <button className={styles.primary} type="button" disabled={busy} onClick={() => void signIn()}>{busy ? "Signing in…" : "Connect and sign in"}</button></>}
        </div>
        <form className={styles.paper} onSubmit={event => { event.preventDefault(); void accept(); }}>
          <h2>2. Accept your invitation</h2>
          <label htmlFor="invitation">Invitation code</label>
          <input id="invitation" type="password" value={invite} onChange={event => { setInvite(event.target.value.trim()); setMessage(""); }} maxLength={128}
            autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={busy} aria-describedby="invite-help" />
          <p id="invite-help" className={styles.help}>Paste the code your host gave you. Opening this page never accepts it automatically.</p>
          <button className={styles.primary} type="submit" disabled={busy || !session || !/^[a-f0-9]{64}$/i.test(invite.trim())}>{busy ? "Please wait…" : "Accept invitation"}</button>
        </form>
      </>}
      <p role="status" aria-live="polite">{message}</p>
      <nav className={styles.links}><Link href="/charmville/start">Create or finish your profile</Link><Link href="/plankspace">Back to PlankSpace</Link></nav>
    </section>
  </main>;
}
