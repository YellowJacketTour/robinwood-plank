"use client";

import { useState } from "react";

type Identity = { displayName: string; isAdmin: boolean; roomId?: string | null };
type InvitePreview = { roomId: string | null; roomName: string | null; joinCode: string | null; hostName: string | null } | null;
type Props = { initialIdentity: Identity | null; adminConfigured: boolean; initialInvite: string; initialSetup: string; invitePreview: InvitePreview; publicRegistration: boolean };

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || "The request failed.");
  return body;
}

export function PasskeyGate({ initialIdentity, adminConfigured, initialInvite: invite, initialSetup: setup, invitePreview, publicRegistration }: Props) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [newPlayer, setNewPlayer] = useState(publicRegistration);
  const mode = !adminConfigured && setup ? "bootstrap" : invite ? "register" : publicRegistration && newPlayer ? "registerPublic" : "login";

  async function enter() {
    setBusy(true); setMessage("");
    try {
      const result = await json<Identity>(await fetch("/api/playtest/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: mode, displayName, pin, invite, setup }),
      }));
      setIdentity(result); setPin("");
      if (result.roomId) window.location.assign(`/playtest/game?room=${encodeURIComponent(result.roomId)}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Entry failed."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await fetch("/api/playtest/session", { method: "DELETE" }); setIdentity(null); }
    finally { setBusy(false); }
  }

  async function joinInvitedTable() {
    setBusy(true); setMessage("");
    try {
      const result = await json<Identity>(await fetch("/api/playtest/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "joinInvite", invite }),
      }));
      if (result.roomId) window.location.assign(`/playtest/game?room=${encodeURIComponent(result.roomId)}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not join the table."); }
    finally { setBusy(false); }
  }

  if (identity) return <section className="data-module rounded-xl border border-line p-6">
    <p className="text-xs font-black uppercase tracking-[0.12em] text-gold-400">{identity.isAdmin ? "Host console unlocked" : "Player admitted"}</p>
    <h2 className="mt-2 text-2xl text-gold-300">Welcome, {identity.displayName}</h2>
    <p className="mt-3 text-sm text-cream-muted">This session controls simulation credits only. It cannot sign transactions or move mainnet assets.</p>
    <div className="mt-5 flex flex-wrap gap-3">
      {invitePreview?.roomId && invite ? <button className="min-h-11 rounded-md bg-gold-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-wood-950 disabled:opacity-40" disabled={busy} onClick={joinInvitedTable}>{busy ? "Joining…" : `Join ${invitePreview.roomName || "invited table"}`}</button>
        : <a className="min-h-11 rounded-md bg-gold-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-wood-950" href="/playtest/game">{identity.isAdmin ? "Open host table" : "Enter game"}</a>}
      <button className="min-h-11 rounded-md border border-line-strong bg-panel-strong px-4 text-xs font-black uppercase tracking-wider text-gold-300" disabled={busy} onClick={signOut}>Sign out</button>
    </div>
    {message ? <p className="mt-4 rounded-md bg-panel-strong p-3 text-sm text-red-400" role="alert">{message}</p> : null}
  </section>;

  return <section className="overflow-hidden rounded-2xl border border-gold-500/30 bg-panel shadow-2xl">
    {mode === "register" ? <div className="border-b border-line bg-gradient-to-r from-wood-950 to-panel-strong px-6 py-5">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gold-400">Private table invitation</p>
      <h2 className="mt-2 text-3xl text-gold-300">{invitePreview?.roomName || "A PlankCrash table awaits"}</h2>
      <p className="mt-2 text-sm text-cream-muted">{invitePreview?.hostName ? `${invitePreview.hostName} invited you to gather, fly, and settle a shared round.` : "Create your player to cross the threshold into the private alpha."}</p>
      {invitePreview?.joinCode ? <p className="mt-4 inline-flex rounded-md border border-gold-500/30 bg-black/20 px-3 py-2 font-mono text-xs font-black tracking-[0.14em] text-gold-300">TABLE {invitePreview.joinCode}</p> : null}
    </div> : null}
    <div className="p-6">
    <h2 className="text-2xl text-gold-300">{mode === "bootstrap" ? "Claim the host account" : mode === "register" ? "Create your invited player" : mode === "registerPublic" ? "Create your test player" : "Return to the PlankCrash alpha"}</h2>
    <p className="mt-2 text-sm text-cream-muted">{mode === "bootstrap" ? "Choose your permanent host username and enter the six-digit PIN you want to use. This can happen only once." : mode === "register" ? "This table invitation remains reusable for the invited group for seven days. Choose a unique username and your own four-digit PIN." : mode === "registerPublic" ? "Choose a unique username and personal four-digit PIN. Test credits have no value and cannot leave the laboratory." : "Enter your existing username and personal four- or six-digit PIN."}</p>
    {publicRegistration && !invite && mode !== "bootstrap" ? <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-line bg-black/20 p-1"><button type="button" className={`min-h-10 rounded-md text-xs font-black uppercase tracking-wider ${newPlayer ? "bg-gold-500 text-wood-950" : "text-gold-300"}`} onClick={() => { setNewPlayer(true); setMessage(""); }}>New player</button><button type="button" className={`min-h-10 rounded-md text-xs font-black uppercase tracking-wider ${!newPlayer ? "bg-gold-500 text-wood-950" : "text-gold-300"}`} onClick={() => { setNewPlayer(false); setMessage(""); }}>Returning</button></div> : null}
    <label className="mt-5 block text-xs font-black uppercase tracking-wider text-gold-300">Username
      <input autoComplete="nickname" className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 text-cream outline-none focus:border-line-strong" maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
    </label>
    <label className="mt-4 block text-xs font-black uppercase tracking-wider text-gold-300">Secret PIN
      <input aria-describedby="pin-help" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 font-mono text-cream outline-none focus:border-line-strong" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
    </label>
    <p id="pin-help" className="mt-2 text-xs text-cream-muted">{mode === "bootstrap" ? "Exactly 6 digits. Keep this private." : mode === "register" || mode === "registerPublic" ? "Exactly 4 digits. Remember it for future visits." : "Players use 4 digits; the host uses 6."}</p>
    <button className="mt-5 min-h-11 w-full rounded-md bg-gold-500 px-4 text-xs font-black uppercase tracking-wider text-wood-950 disabled:opacity-40" disabled={busy || !displayName.trim() || (mode === "bootstrap" ? pin.length !== 6 : mode === "register" || mode === "registerPublic" ? pin.length !== 4 : ![4, 6].includes(pin.length))} onClick={enter}>{busy ? "Entering…" : mode === "bootstrap" ? "Set host account" : mode === "register" ? "Create player and join" : mode === "registerPublic" ? "Create player" : "Enter playtest"}</button>
    {message ? <p className="mt-4 rounded-md bg-panel-strong p-3 text-sm text-red-400" role="alert">{message}</p> : null}
    <div className="mt-5 grid grid-cols-3 gap-2 border-t border-line pt-4 text-center text-[10px] font-bold uppercase tracking-wider text-cream-muted"><span>Gather</span><span>Fly</span><span>Settle &amp; grow</span></div>
    </div>
  </section>;
}
