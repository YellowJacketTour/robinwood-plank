"use client";
import { useRef, useState } from "react";
import { attachLocalPlaytestWallet } from "@/lib/charmville/local-playtest-client";
import "../../world/world-shell.css";
import styles from "../access.module.css";

export default function LocalRuntime() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const working = useRef(false);
  async function enter() {
    if (working.current || window.location.origin !== "http://localhost:3018") return;
    working.current = true; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/charmville/local-runtime-fixture", { method: "POST", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const fixture = await response.json();
      if (!response.ok || fixture.synthetic !== true || typeof fixture.token !== "string" || !/^[a-f0-9]{64}$/.test(fixture.token) || typeof fixture.wallet !== "string" || !/^0x[a-f0-9]{40}$/.test(fixture.wallet)) throw new Error("The isolated fixture is unavailable. Please try again after the operator checks it.");
      localStorage.setItem(`plankspace-session:${fixture.wallet}`, fixture.token);
      localStorage.setItem("plankspace-last-verified-wallet", fixture.wallet);
      attachLocalPlaytestWallet(fixture.wallet);
      window.location.assign("/charmville/world?panel=play");
    } catch { setMessage("The isolated playtest could not open. No real wallet connection or signature was requested."); }
    finally { working.current = false; setBusy(false); }
  }
  return <main className={`charm-world ${styles.page}`} data-market-shell><section className={styles.card}>
    <p className={styles.eyebrow}>Local browser acceptance · Synthetic account</p><h1>Enter the isolated playtest</h1>
    <p>This uses a temporary guest in the separate test database. It never connects or signs with your wallet.</p>
    <button type="button" className={styles.primary} disabled={busy} onClick={() => void enter()}>{busy ? "Opening test account..." : "Enter isolated playtest"}</button>
    <p role="status">{message}</p>
  </section></main>;
}
