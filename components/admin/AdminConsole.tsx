"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet-context";
import { SkeletonStatus, SkeletonText } from "@/components/Skeleton";
import { ExplorerAddress } from "./ExplorerAddress";
import { BUTTON_PRIMARY, CARD, LABEL } from "./ui";
import MusicSection from "./sections/MusicSection";
import ContentSection from "./sections/ContentSection";
import SystemSection from "./sections/SystemSection";
import FinanceSection from "./sections/FinanceSection";
import AnalyticsSection from "./sections/AnalyticsSection";
import CollectionsSection from "./sections/CollectionsSection";
import FlagsSection from "./sections/FlagsSection";

/**
 * /admin — the RobinWood management console shell.
 *
 * Left rail (horizontal scroll rail on mobile) of sections; each section is
 * an independent component under components/admin/sections/ so future tools
 * register one menu entry + one component. Deep-linkable via ?section=,
 * synced with history.replaceState (no useSearchParams — the page stays a
 * plain server shell without a Suspense boundary).
 *
 * Authorization is per-mutation wallet signatures (lib/admin-auth.ts) —
 * connecting only fills in the signer; every save is individually signed and
 * server-verified. Read-only sections work without a wallet.
 */

type SectionId =
  | "music"
  | "content"
  | "collections"
  | "flags"
  | "finance"
  | "analytics"
  | "system";

const SECTIONS: {
  id: SectionId;
  label: string;
  // Read-only sections ignore the prop; declaring the widest signature here
  // lets the shell render every section uniformly.
  component: React.ComponentType<{ address: string | null }>;
}[] = [
  { id: "music", label: "Music", component: MusicSection },
  { id: "content", label: "Content", component: ContentSection },
  { id: "collections", label: "Collections", component: CollectionsSection },
  { id: "flags", label: "Flags", component: FlagsSection },
  { id: "finance", label: "Finance", component: FinanceSection },
  { id: "analytics", label: "Analytics", component: AnalyticsSection },
  { id: "system", label: "System", component: SystemSection },
];

function sectionFromLocation(): SectionId {
  if (typeof window === "undefined") return "music";
  const requested = new URLSearchParams(window.location.search).get("section");
  return SECTIONS.some((s) => s.id === requested)
    ? (requested as SectionId)
    : "music";
}

export default function AdminConsole() {
  const { address, isConnected, status, openConnect } = useWallet();
  const [section, setSection] = useState<SectionId>("music");
  // null = not yet checked. The console is management tooling, not a public
  // page: it stays hidden until we know the connected wallet can actually use
  // it. This is presentation only — every save is still verified by signature
  // server-side, so a forged "true" here buys nothing.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!address) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsAdmin(null);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/whoami?address=${encodeURIComponent(address)}`,
          { signal: controller.signal, cache: "no-store" }
        );
        const data = (await res.json()) as { isAdmin?: boolean };
        if (!controller.signal.aborted) setIsAdmin(Boolean(data.isAdmin));
      } catch {
        // Fail closed: an unreachable check shows the "not an admin" notice
        // rather than the tools.
        if (!controller.signal.aborted) setIsAdmin(false);
      }
    })();
    return () => controller.abort();
  }, [address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSection(sectionFromLocation());
    const onPop = () => setSection(sectionFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((id: SectionId) => {
    setSection(id);
    const url = new URL(window.location.href);
    url.searchParams.set("section", id);
    window.history.replaceState(null, "", url);
  }, []);

  const Active =
    SECTIONS.find((s) => s.id === section)?.component ?? MusicSection;

  return (
    <>
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">
          Admin
        </h1>
        <p className="max-w-xl text-sm text-cream-muted">
          Management console. Every change is signed by your wallet and
          verified server-side against the admin allowlist — nothing saves
          without a signature.
        </p>
      </header>

      {!isConnected ? (
        <section className={CARD}>
          <h2 className={LABEL}>Wallet</h2>
          <p className="mt-2 max-w-lg text-sm text-cream">
            Connect the admin wallet to use the management console.
          </p>
          <button
            type="button"
            className={`${BUTTON_PRIMARY} mt-4`}
            onClick={openConnect}
            disabled={status === "connecting"}
          >
            {status === "connecting" ? "Connecting…" : "Connect wallet"}
          </button>
        </section>
      ) : isAdmin === null ? (
        <section className={CARD}>
          <SkeletonStatus>Checking the admin allowlist</SkeletonStatus>
          <SkeletonText lines={2} className="max-w-lg" />
        </section>
      ) : !isAdmin ? (
        <section className={CARD}>
          <h2 className={LABEL}>Not an admin wallet</h2>
          <p className="mt-2 max-w-lg text-sm text-cream">
            {address ? <ExplorerAddress address={address} short /> : "This wallet"} is
            not on the admin allowlist. Connect a wallet that is, and the
            console will appear.
          </p>
        </section>
      ) : null}

      {isConnected && isAdmin ? (
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-[190px_1fr]">
        <nav aria-label="Admin sections" className="lg:sticky lg:top-24 lg:self-start">
          <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => navigate(s.id)}
                  aria-current={section === s.id ? "page" : undefined}
                  className={`inline-flex min-h-11 w-full items-center rounded-md px-3 text-xs font-black uppercase tracking-[0.12em] transition-colors lg:text-[0.6875rem] ${
                    section === s.id
                      ? "bg-gold-500/15 text-gold-300"
                      : "text-cream-muted hover:bg-gold-500/10 hover:text-gold-300"
                  }`}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4 sm:space-y-6">
          <Active address={address} />
        </div>
      </div>
      ) : null}
    </>
  );
}
