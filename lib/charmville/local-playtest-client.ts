"use client";

let activeWallet = "";

export function localPlaytestWallet(): string {
  if(process.env.NODE_ENV !== "development" || typeof window === "undefined" ||
    !["/charmville/play","/charmville/world"].includes(window.location.pathname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname))return "";
  const candidate=activeWallet||sessionStorage.getItem('charmville-local-test-wallet')||'';
  return /^0x[a-f0-9]{40}$/.test(candidate)?candidate:'';
}

/** A route-scoped display identity; the server still verifies the real local session token. */
export function attachLocalPlaytestWallet(wallet: string): () => void {
  activeWallet = /^0x[a-f0-9]{40}$/.test(wallet) ? wallet : "";
  if(activeWallet&&typeof window!=='undefined')sessionStorage.setItem('charmville-local-test-wallet',activeWallet);
  return () => { if (activeWallet === wallet) {activeWallet = "";sessionStorage.removeItem('charmville-local-test-wallet');} };
}
