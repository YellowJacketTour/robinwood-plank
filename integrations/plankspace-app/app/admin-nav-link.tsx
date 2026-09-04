"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getPlankLoveWalletState,
  subscribePlankLoveWalletState,
} from "./plank-love-wallet";

const ADMINS = new Set([
  "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d",
  "0x7304b78e28370f45fdf77ca67bdbbf550c3aac34",
]);

export default function AdminNavLink({ className }: { className?: string }) {
  const [wallet, setWallet] = useState("");
  useEffect(() => {
    const sync = (address: string | null) => setWallet((address || "").toLowerCase());
    const unsubscribe = subscribePlankLoveWalletState(state => sync(state.address));
    void getPlankLoveWalletState().then(state => sync(state.address)).catch(() => undefined);
    return unsubscribe;
  }, []);
  return ADMINS.has(wallet) ? <Link href="/plankspace/admin" className={className}>Admin</Link> : null;
}
