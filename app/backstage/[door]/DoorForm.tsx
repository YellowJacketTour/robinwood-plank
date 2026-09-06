"use client";

import { useState, type FormEvent } from "react";

export default function DoorForm() {
  const [user, setUser] = useState("");
  const [pin, setPin] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("busy");
    setMessage(null);
    try {
      const res = await fetch("/api/market/door", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, pin }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: string };
      if (res.ok && data.ok) {
        window.location.assign(data.redirect ?? "/market/multichain");
        return;
      }
      setState("error");
      setMessage(res.status === 429 ? "Too many attempts. Wait ten minutes." : data.error ?? "Not recognised.");
    } catch {
      setState("error");
      setMessage("Could not reach the door.");
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-xs space-y-3 rounded-lg border border-line bg-panel p-5">
      <h1 className="font-display text-xl text-gold-300">Backstage</h1>
      <p className="text-xs text-foreground/60">Private preview of Marketplank while the public gate is closed.</p>
      <label className="block text-xs text-foreground/70">
        User
        <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" className="mt-1 w-full rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground" />
      </label>
      <label className="block text-xs text-foreground/70">
        PIN
        <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="current-password" className="mt-1 w-full rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground" />
      </label>
      {message && <p className="text-xs text-red-400">{message}</p>}
      <button type="submit" disabled={state === "busy"} className="w-full rounded-md border border-gold-400/60 bg-gold-400/10 px-3 py-2 text-sm font-semibold text-gold-300 disabled:opacity-50">
        {state === "busy" ? "Opening…" : "Enter"}
      </button>
    </form>
  );
}
