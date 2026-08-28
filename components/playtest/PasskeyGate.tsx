"use client";

import { useState } from "react";

type Identity = { displayName: string; isAdmin: boolean };
type Props = { initialIdentity: Identity | null; adminConfigured: boolean; initialInvite: string; initialSetup: string };

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || "The request failed.");
  return body;
}

export function PasskeyGate({ initialIdentity, adminConfigured, initialInvite: invite, initialSetup: setup }: Props) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mode = !adminConfigured && setup ? "bootstrap" : invite ? "register" : "login";

  async function enter() {
    setBusy(true); setMessage("");
    try {
      const result = await json<Identity>(await fetch("/api/playtest/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: mode, displayName, pin, invite, setup }),
      }));
      setIdentity(result); setPin("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Entry failed."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await fetch("/api/playtest/session", { method: "DELETE" }); setIdentity(null); }
    finally { setBusy(false); }
  }

  if (identity) return <section className="data-module rounded-xl border border-line p-6">
    <p className="text-xs font-black uppercase tracking-[0.12em] text-gold-400">{identity.isAdmin ? "Host console unlocked" : "Player admitted"}</p>
    <h2 className="mt-2 text-2xl text-gold-300">Welcome, {identity.displayName}</h2>
    <p className="mt-3 text-sm text-cream-muted">This session controls simulation credits only. It cannot sign transactions or move mainnet assets.</p>
    <div className="mt-5 flex flex-wrap gap-3">
      <a className="min-h-11 rounded-md bg-gold-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-wood-950" href="/playtest/game">{identity.isAdmin ? "Open host console" : "Enter game"}</a>
      <button className="min-h-11 rounded-md border border-line-strong bg-panel-strong px-4 text-xs font-black uppercase tracking-wider text-gold-300" disabled={busy} onClick={signOut}>Sign out</button>
    </div>
  </section>;

  return <section className="rounded-xl border border-line bg-panel p-6">
    <h2 className="text-2xl text-gold-300">{mode === "bootstrap" ? "Claim the host account" : mode === "register" ? "Create your invited player" : "Return to the private playtest"}</h2>
    <p className="mt-2 text-sm text-cream-muted">{mode === "bootstrap" ? "Choose your permanent host username and enter the six-digit PIN you want to use. This can happen only once." : mode === "register" ? "This is a one-use invitation. Choose a unique username and your own four-digit PIN." : "Enter your existing username and personal four- or six-digit PIN."}</p>
    <label className="mt-5 block text-xs font-black uppercase tracking-wider text-gold-300">Username
      <input autoComplete="nickname" className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 text-cream outline-none focus:border-line-strong" maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
    </label>
    <label className="mt-4 block text-xs font-black uppercase tracking-wider text-gold-300">Secret PIN
      <input aria-describedby="pin-help" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]*" className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 font-mono text-cream outline-none focus:border-line-strong" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
    </label>
    <p id="pin-help" className="mt-2 text-xs text-cream-muted">{mode === "bootstrap" ? "Exactly 6 digits. Keep this private." : mode === "register" ? "Exactly 4 digits. Remember it for future visits." : "Players use 4 digits; the host uses 6."}</p>
    <button className="mt-5 min-h-11 w-full rounded-md bg-gold-500 px-4 text-xs font-black uppercase tracking-wider text-wood-950 disabled:opacity-40" disabled={busy || !displayName.trim() || (mode === "bootstrap" ? pin.length !== 6 : mode === "register" ? pin.length !== 4 : ![4, 6].includes(pin.length))} onClick={enter}>{busy ? "Entering…" : mode === "bootstrap" ? "Set host account" : mode === "register" ? "Create player and join" : "Enter playtest"}</button>
    {message ? <p className="mt-4 rounded-md bg-panel-strong p-3 text-sm text-red-400" role="alert">{message}</p> : null}
  </section>;
}
