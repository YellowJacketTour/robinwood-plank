"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { savedWalletProof, walletProof } from "@/integrations/plankspace-app/app/auth-client";
import { connectPlankLoveWallet, subscribePlankLoveWalletState } from "@/integrations/plankspace-app/app/plank-love-wallet";
import "../../world/world-shell.css";
import styles from "./invitation-admin.module.css";

type Invite = { inviteId: string; issuedBy: string; recipientHandle: string | null; createdAt: string; inviteExpiresAt: string; accessDays: number; revokedAt: string | null; redeemedAt: string | null; redeemedByProfileId: string | null; grantedUntil: string | null };
type Issued = { inviteId: string; inviteToken: string; inviteExpiresAt: string; accessDays: number };
type Command = { action: "create"; inviteHours: number; accessDays: number; recipientHandle?: string } | { action: "revoke"; inviteId: string } | { action: "revokeGrant"; profileId: string };
type Session = { wallet: string; token: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
function validInvite(v: unknown): v is Invite {
  return object(v) && uuid(v.inviteId) && typeof v.issuedBy === "string" && (v.recipientHandle === null || typeof v.recipientHandle === "string") && date(v.createdAt) && date(v.inviteExpiresAt) && Number.isInteger(v.accessDays) && Number(v.accessDays) >= 1 && Number(v.accessDays) <= 90 &&
    (v.revokedAt === null || date(v.revokedAt)) && (v.redeemedAt === null || date(v.redeemedAt)) && (v.grantedUntil === null || date(v.grantedUntil)) && (v.redeemedByProfileId === null || typeof v.redeemedByProfileId === "string" && /^[1-9]\d{0,17}$/.test(v.redeemedByProfileId));
}

export default function InvitationAdmin() {
  const [session, setSession] = useState<Session | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [confirmation, setConfirmation] = useState<Command | null>(null);
  const [recipient, setRecipient] = useState("");
  const [hours, setHours] = useState(24);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0), currentWallet = useRef<string | null>(null), working = useRef(false), mounted = useRef(true);

  async function request(token: string, command?: Command): Promise<unknown> {
    const abort = new AbortController(); const timer = window.setTimeout(() => abort.abort(), 20_000);
    try {
      const response = await fetch("/api/charmville/invites", { method: command ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: command ? JSON.stringify(command) : undefined, cache: "no-store", mode: "same-origin", redirect: "error", signal: abort.signal });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(object(data) && typeof data.error === "string" ? data.error : "The invitation desk is unavailable."), { definitive: response.status >= 400 && response.status < 500, status: response.status });
      return data;
    } finally { window.clearTimeout(timer); }
  }

  async function refresh(current = session) {
    if (!current || working.current) return;
    working.current = true; setBusy(true); setMessage("");
    const version = generation.current;
    try {
      const result = await request(current.token);
      if (!object(result) || !Array.isArray(result.invites) || result.invites.length > 100 || !result.invites.every(validInvite)) throw new Error("Invitation details were incomplete. Please refresh again.");
      if (mounted.current && version === generation.current) { setInvites(result.invites); setUncertain(false); }
    } catch (error) {
      if (mounted.current && version === generation.current) { setInvites(null); if (error instanceof Error && "status" in error && error.status === 401) setSession(null); setMessage(error instanceof Error ? error.message : "Invitation details could not be loaded."); }
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  useEffect(() => {
    const epochs = generation; mounted.current = true;
    const stop = subscribePlankLoveWalletState(state => {
      const address = state.address?.toLowerCase() ?? null;
      if (address === currentWallet.current) return;
      currentWallet.current = address; const version = ++generation.current;
      setSession(null); setInvites(null); setIssued(null); setConfirmation(null); setUncertain(false); setMessage("");
      if (address && !working.current) void savedWalletProof(address).then(proof => {
        if (mounted.current && version === generation.current && proof.sessionToken) setSession({ wallet: address, token: proof.sessionToken });
      }).catch(() => { if (mounted.current && version === generation.current) setMessage("Please sign in again."); });
    });
    return () => { mounted.current = false; ++epochs.current; stop(); };
  }, []);

  async function signIn() {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage("");
    try {
      const address = (await connectPlankLoveWallet()).toLowerCase();
      if (!mounted.current) return;
      if (currentWallet.current && currentWallet.current !== address) throw new Error("Your account changed. Please sign in again.");
      currentWallet.current = address; const version = ++generation.current;
      const proof = await walletProof(address, "profile:read", address, { wallet: address });
      if (mounted.current && version === generation.current) setSession({ wallet: address, token: proof.sessionToken });
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "Sign-in could not finish."); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  async function execute() {
    if (!session || !confirmation || working.current || currentWallet.current !== session.wallet) return;
    const command = confirmation, version = generation.current;
    working.current = true; setBusy(true); setMessage(""); setConfirmation(null);
    try {
      const result = await request(session.token, command);
      if (!mounted.current || version !== generation.current) return;
      if (command.action === "create") {
        if (!object(result) || !uuid(result.inviteId) || typeof result.inviteToken !== "string" || !/^[a-f0-9]{64}$/.test(result.inviteToken) || !date(result.inviteExpiresAt) || result.accessDays !== command.accessDays) throw new Error("The issuance result was incomplete.");
        setIssued(result as Issued); setMessage("Invitation issued. Copy the code before dismissing it.");
      } else {
        if (!object(result) || result.revoked !== true || (command.action === "revoke" ? result.inviteId !== command.inviteId || result.scope !== "invitation" : result.profileId !== command.profileId || result.scope !== "admission-grant")) throw new Error("Revocation could not be confirmed.");
        setMessage(command.action === "revoke" ? "Invitation revoked. Any already-granted access remains separate." : "Invitation-based player access revoked. Configured access remains separate.");
      }
      setInvites(null);
    } catch (error) {
      if (mounted.current && version === generation.current) {
        const definitive = error instanceof Error && "definitive" in error && error.definitive === true;
        if (error instanceof Error && "status" in error && error.status === 401) { setSession(null); setInvites(null); }
        setUncertain(!definitive);
        setMessage(definitive && error instanceof Error ? error.message : "The result is uncertain. Refresh the invitation list before taking another action. Issued codes cannot be recovered from the list.");
      }
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }

  async function copyCode() {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.inviteToken); setMessage("Invitation code copied. Share it privately with your guest."); }
    catch { setMessage("Clipboard unavailable. Select the displayed code and copy it manually."); }
  }

  const valid = Number.isInteger(hours) && hours >= 1 && hours <= 168 && Number.isInteger(days) && days >= 1 && days <= 90 && (!recipient || /^[a-z0-9_]{1,40}$/.test(recipient));
  return <main className={`charm-world ${styles.page}`} data-market-shell><section className={styles.desk} aria-busy={busy}>
    <header><p className={styles.eyebrow}>Charmville · Private playtest</p><h1>Invitation desk</h1><p>Manage invitations with your configured administrator account.</p></header>
    {!session ? <button type="button" disabled={busy} onClick={() => void signIn()}>Connect and sign in</button> : <div className={styles.row}><span>Account {session.wallet.slice(0, 6)}…{session.wallet.slice(-4)}</span><button type="button" disabled={busy} onClick={() => void refresh()}>Refresh invitation list</button></div>}
    {issued && <section className={styles.paper} aria-label="New invitation code"><h2>Copy this invitation now</h2><p>This code is displayed only here. It cannot be retrieved later.</p>
      <textarea readOnly value={issued.inviteToken} aria-label="New invitation code" spellCheck={false} />
      <p>Redeem before {new Date(issued.inviteExpiresAt).toLocaleString()} · {issued.accessDays} days of access.</p>
      <div className={styles.row}><button type="button" onClick={() => void copyCode()}>Copy invitation code</button><button type="button" onClick={() => { setIssued(null); setMessage("Code dismissed. It cannot be retrieved from this page again."); }}>I saved it · dismiss code</button></div>
      <p>Guest redemption page: <Link href="/charmville/access">/charmville/access</Link>. Send the code separately.</p>
    </section>}
    {invites && !issued && <form className={styles.paper} onSubmit={event => { event.preventDefault(); if (valid && !busy && !uncertain) setConfirmation({ action: "create", inviteHours: hours, accessDays: days, ...(recipient ? { recipientHandle: recipient } : {}) }); }}>
      <h2>Invite a guest</h2><label>Recipient handle · optional<input value={recipient} onChange={event => setRecipient(event.target.value.trim().replace(/^@/, "").toLowerCase())} maxLength={40} disabled={busy} placeholder="Only this approved profile can redeem" /></label>
      <div className={styles.fields}><label>Code valid for · hours<input type="number" min={1} max={168} value={hours} onChange={event => setHours(Number(event.target.value))} disabled={busy} /></label><label>Player access · days<input type="number" min={1} max={90} value={days} onChange={event => setDays(Number(event.target.value))} disabled={busy} /></label></div>
      <p>With no recipient, any approved PlankSpace profile holding the code can redeem it once.</p><button type="submit" disabled={!valid || busy || uncertain}>Review invitation</button>
    </form>}
    {confirmation && <section className={styles.paper} aria-label="Confirm invitation action"><h2>{confirmation.action === "create" ? "Issue this invitation?" : "Confirm revocation"}</h2>
      <p>{confirmation.action === "create" ? `${confirmation.recipientHandle ? `For @${confirmation.recipientHandle}` : "For any approved holder"}. Code expires in ${confirmation.inviteHours} hours; grants ${confirmation.accessDays} days of access.` : confirmation.action === "revoke" ? `Revoke invitation ${confirmation.inviteId}? This does not revoke access already granted to a player.` : `Revoke invitation-based access for player ${confirmation.profileId}? Configured administrator or allowed-wallet access is unaffected.`}</p>
      <div className={styles.row}><button type="button" disabled={busy} onClick={() => void execute()}>{confirmation.action === "create" ? "Issue invitation" : "Confirm revoke"}</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button></div>
    </section>}
    <p role="status" aria-live="polite">{message}</p>
    {invites && <section aria-label="Issued invitations"><h2>Latest {invites.length} invitations</h2>{invites.length === 0 && <p>No invitations issued yet.</p>}<div className={styles.list}>{invites.map(invite => <article className={styles.paper} key={invite.inviteId}><h3>{invite.recipientHandle ? `For @${invite.recipientHandle}` : "Any approved holder"}</h3><p className={styles.id}>{invite.inviteId}</p><p>Issued by @{invite.issuedBy} · {invite.accessDays} days of access</p><p>Code deadline: {new Date(invite.inviteExpiresAt).toLocaleString()}</p><p>{invite.revokedAt ? "Invitation revoked" : invite.redeemedAt ? `Redeemed by player ${invite.redeemedByProfileId}` : "Not redeemed"}</p>
      {invite.grantedUntil && <p>Granted until {new Date(invite.grantedUntil).toLocaleString()}</p>}<div className={styles.row}>
        {!invite.revokedAt && <button type="button" disabled={busy || uncertain} onClick={() => setConfirmation({ action: "revoke", inviteId: invite.inviteId })}>Revoke invitation…</button>}
        {invite.redeemedByProfileId && <button type="button" disabled={busy || uncertain} onClick={() => setConfirmation({ action: "revokeGrant", profileId: invite.redeemedByProfileId! })}>Revoke player access…</button>}
      </div></article>)}</div></section>}
    <footer><Link href="/charmville/access">Guest invitation page</Link><Link href="/charmville/world?panel=play">Return to Charmville</Link></footer>
  </section></main>;
}
