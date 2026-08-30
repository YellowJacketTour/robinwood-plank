import { notFound } from "next/navigation";
import type { Metadata } from "next";
import AppBackdrop from "@/components/AppBackdrop";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { PasskeyGate } from "@/components/playtest/PasskeyGate";
import { adminConfigured, currentPlaytestIdentity, playtestBootstrapAllowed, playtestEnabled, playtestInvitePreview } from "@/lib/playtest-auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function PlaytestPage({ searchParams }: { searchParams: Promise<{ invite?: string | string[]; setup?: string | string[] }> }) {
  if (!playtestEnabled()) notFound();
  const [identity, configured, query] = await Promise.all([currentPlaytestIdentity(), adminConfigured(), searchParams]);
  const initialInvite = typeof query.invite === "string" ? query.invite : "";
  const initialSetup = typeof query.setup === "string" && playtestBootstrapAllowed(query.setup) ? query.setup : "";
  const invitePreview = initialInvite ? await playtestInvitePreview(initialInvite) : null;
  return <>
    <AppBackdrop />
    <Nav />
    <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-6 sm:px-5 sm:py-10">
      <div data-market-shell className="mx-auto w-full max-w-[1100px] space-y-8">
        <header className="max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-gold-400">Private alpha · no value · authoritative simulation</p>
          <h1 className="mt-3 text-4xl text-gold-300 sm:text-6xl">{invitePreview ? "Your table is waiting." : "Gather. Fly. Settle. Return."}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-cream-muted">A live parimutuel crash expedition among friends. Commit test credits, lock your multiplier before the flight ends, and see every balance, vault, lottery, and group consequence carried into what comes next.</p>
        </header>
        <div className="max-w-2xl"><PasskeyGate adminConfigured={configured} initialInvite={initialInvite} initialSetup={initialSetup} initialIdentity={identity ? { displayName: identity.displayName, isAdmin: identity.isAdmin } : null} invitePreview={invitePreview} /></div>
        <section aria-label="The PlankCrash journey" className="grid gap-3 sm:grid-cols-3">
          <article className="rounded-xl border border-line bg-panel/70 p-5"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-gold-400">01 · Gather</p><h2 className="mt-2 text-2xl text-gold-300">Meet at one table</h2><p className="mt-2 text-sm leading-6 text-cream-muted">A host invites friends. Everyone sees the same readiness, pool, and rules before departure.</p></article>
          <article className="rounded-xl border border-line bg-panel/70 p-5"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-gold-400">02 · Fly</p><h2 className="mt-2 text-2xl text-gold-300">Choose your moment</h2><p className="mt-2 text-sm leading-6 text-cream-muted">The server clock drives one shared ascent. Lock freely before the committed crash.</p></article>
          <article className="rounded-xl border border-line bg-panel/70 p-5"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-gold-400">03 · Return</p><h2 className="mt-2 text-2xl text-gold-300">Account for everything</h2><p className="mt-2 text-sm leading-6 text-cream-muted">Review personal and group outcomes, persistent value movements, and the stronger next-round foundation.</p></article>
        </section>
        <p className="max-w-3xl rounded-lg border border-line bg-black/20 px-4 py-3 text-xs leading-5 text-cream-muted">This alpha uses the intended multiplayer flow and economic kernel with test credits only. It cannot sign transactions, access wallets, or move mainnet assets.</p>
      </div>
    </main>
    <Footer />
  </>;
}
