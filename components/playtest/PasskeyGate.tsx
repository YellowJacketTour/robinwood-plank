"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";

type Props = { initialIdentity: { displayName: string } | null };

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || "The request failed.");
  return body;
}

export function PasskeyGate({ initialIdentity }: Props) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [invite, setInvite] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function register() {
    setBusy(true); setMessage("");
    try {
      const started = await json<{ ceremonyId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
        await fetch("/api/playtest/passkeys/register/options", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite, displayName }),
        })
      );
      const response = await startRegistration({ optionsJSON: started.options });
      const finished = await json<{ displayName: string }>(await fetch("/api/playtest/passkeys/register/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ceremonyId: started.ceremonyId, response }),
      }));
      setIdentity({ displayName: finished.displayName }); setInvite("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Registration failed."); }
    finally { setBusy(false); }
  }

  async function signIn() {
    setBusy(true); setMessage("");
    try {
      const started = await json<{ ceremonyId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
        await fetch("/api/playtest/passkeys/authenticate/options", { method: "POST" })
      );
      const response = await startAuthentication({ optionsJSON: started.options });
      const finished = await json<{ displayName: string }>(await fetch("/api/playtest/passkeys/authenticate/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ceremonyId: started.ceremonyId, response }),
      }));
      setIdentity({ displayName: finished.displayName });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await fetch("/api/playtest/session", { method: "DELETE" }); setIdentity(null); }
    finally { setBusy(false); }
  }

  if (identity) return (
    <section className="data-module rounded-xl border border-line p-6">
      <p className="text-xs font-black uppercase tracking-[0.12em] text-gold-400">Authenticated laboratory</p>
      <h2 className="mt-2 text-2xl text-gold-300">Welcome, {identity.displayName}</h2>
      <p className="mt-3 text-sm text-cream-muted">Your passkey grants access only to permissioned simulations. It cannot sign transactions or move mainnet assets.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <a className="min-h-11 rounded-md bg-gold-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-wood-950" href="/playtest/game">Enter game laboratory</a>
        <button className="min-h-11 rounded-md border border-line-strong bg-panel-strong px-4 text-xs font-black uppercase tracking-wider text-gold-300" disabled={busy} onClick={signOut}>Sign out</button>
      </div>
    </section>
  );

  return (
    <section className="rounded-xl border border-line bg-panel p-6">
      <h2 className="text-2xl text-gold-300">Enter with a passkey</h2>
      <p className="mt-2 text-sm text-cream-muted">Returning testers can sign in immediately. New testers need a one-use invitation.</p>
      <button className="mt-5 min-h-11 w-full rounded-md bg-gold-500 px-4 text-xs font-black uppercase tracking-wider text-wood-950" disabled={busy} onClick={signIn}>Use existing passkey</button>
      <div className="my-6 h-px bg-line" />
      <label className="block text-xs font-black uppercase tracking-wider text-gold-300">Display name
        <input className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 text-cream outline-none focus:border-line-strong" maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="mt-4 block text-xs font-black uppercase tracking-wider text-gold-300">Invitation
        <input className="mt-2 min-h-11 w-full rounded-md border border-line bg-panel-strong px-3 text-cream outline-none focus:border-line-strong" autoComplete="one-time-code" value={invite} onChange={(e) => setInvite(e.target.value)} />
      </label>
      <button className="mt-5 min-h-11 w-full rounded-md border border-line-strong bg-panel-strong px-4 text-xs font-black uppercase tracking-wider text-gold-300" disabled={busy || !invite || !displayName} onClick={register}>Create passkey</button>
      {message ? <p className="mt-4 rounded-md bg-panel-strong p-3 text-sm text-red-400" role="alert">{message}</p> : null}
    </section>
  );
}

