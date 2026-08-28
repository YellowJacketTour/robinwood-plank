import { notFound } from "next/navigation";
import type { Metadata } from "next";
import AppBackdrop from "@/components/AppBackdrop";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { PasskeyGate } from "@/components/playtest/PasskeyGate";
import { adminConfigured, currentPlaytestIdentity, playtestBootstrapAllowed, playtestEnabled } from "@/lib/playtest-auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function PlaytestPage({ searchParams }: { searchParams: Promise<{ invite?: string | string[]; setup?: string | string[] }> }) {
  if (!playtestEnabled()) notFound();
  const [identity, configured, query] = await Promise.all([currentPlaytestIdentity(), adminConfigured(), searchParams]);
  const initialInvite = typeof query.invite === "string" ? query.invite : "";
  const initialSetup = typeof query.setup === "string" && playtestBootstrapAllowed(query.setup) ? query.setup : "";
  return <>
    <AppBackdrop />
    <Nav />
    <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-6 sm:px-5 sm:py-10">
      <div data-market-shell className="mx-auto w-full max-w-[1100px] space-y-6">
        <header className="max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-gold-400">Unofficial permissioned simulation — no value</p>
          <h1 className="mt-3 text-4xl text-gold-300">Plank Crash Playtest</h1>
          <p className="mt-4 text-cream-muted">Hosted through RobinWood&apos;s official application and PostgreSQL infrastructure, but isolated from production contracts, wallets, balances, and settlement authority.</p>
        </header>
        <div className="max-w-xl"><PasskeyGate adminConfigured={configured} initialInvite={initialInvite} initialSetup={initialSetup} initialIdentity={identity ? { displayName: identity.displayName, isAdmin: identity.isAdmin } : null} /></div>
      </div>
    </main>
    <Footer />
  </>;
}
