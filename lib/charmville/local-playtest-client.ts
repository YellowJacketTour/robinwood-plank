"use client";

let activeWallet = "";

export function localPlaytestWallet(): string {
  return process.env.NODE_ENV === "development" && typeof window !== "undefined" &&
    window.location.pathname === "/charmville/play" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) ? activeWallet : "";
}

/** A route-scoped display identity; the server still verifies the real local session token. */
export function attachLocalPlaytestWallet(wallet: string): () => void {
  activeWallet = /^0x[a-f0-9]{40}$/.test(wallet) ? wallet : "";
  return () => { if (activeWallet === wallet) activeWallet = ""; };
}
