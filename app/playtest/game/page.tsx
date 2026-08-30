import { notFound, redirect } from "next/navigation";
import AppBackdrop from "@/components/AppBackdrop";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { GameLaboratory } from "@/components/playtest/GameLaboratory";
import { currentPlaytestIdentity, playtestEnabled } from "@/lib/playtest-auth";

export const dynamic = "force-dynamic";

export default async function PlaytestGamePage({ searchParams }: { searchParams: Promise<{ classic?: string; room?: string }> }) {
  if (!playtestEnabled()) notFound();
  const [identity, query] = await Promise.all([currentPlaytestIdentity(), searchParams]);
  if (!identity) redirect("/playtest");
  if (query.classic !== "1") {
    const room = typeof query.room === "string" && /^[0-9a-f-]{36}$/i.test(query.room) ? query.room : "";
    return <main id="main-content" className="fixed inset-0 bg-black">
      <iframe
        src={`/arcade/crash.html?playtest=1${room ? `&room=${encodeURIComponent(room)}` : ""}`}
        title="PlankCrash private multiplayer table"
        className="h-full w-full border-0"
        allow="clipboard-write"
      />
    </main>;
  }
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
