import { notFound, redirect } from "next/navigation";
import AppBackdrop from "@/components/AppBackdrop";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { GameLaboratory } from "@/components/playtest/GameLaboratory";
import { currentPlaytestIdentity, playtestEnabled } from "@/lib/playtest-auth";

export const dynamic = "force-dynamic";

export default async function PlaytestGamePage() {
  if (!playtestEnabled()) notFound();
  const identity = await currentPlaytestIdentity();
  if (!identity) redirect("/playtest");
  return <>
    <AppBackdrop />
    <Nav />
    <main id="main-content" tabIndex={-1} className="flex-1 px-3 py-6 sm:px-5 sm:py-10">
      <div data-market-shell className="mx-auto w-full max-w-[1400px]">
        <GameLaboratory identity={identity} />
      </div>
    </main>
    <Footer />
  </>;
}
